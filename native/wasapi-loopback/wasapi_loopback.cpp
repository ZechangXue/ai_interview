#ifdef _WIN32

#define NAPI_VERSION 8
#include <napi.h>
#include <node_api.h>
#include <uv.h>
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <cmath>
#include <atomic>
#include <thread>
#include <vector>
#include <queue>
#include <mutex>
#include <string>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "user32.lib")

static const CLSID CLSID_MMDeviceEnumerator = __uuidof(MMDeviceEnumerator);
static const IID IID_IMMDeviceEnumerator = __uuidof(IMMDeviceEnumerator);
static const IID IID_IAudioClient = __uuidof(IAudioClient);
static const IID IID_IAudioCaptureClient = __uuidof(IAudioCaptureClient);

struct CallbackPayload {
  uint8_t* data;
  size_t length;
};

struct CaptureContext {
  std::vector<int16_t> outBuf;
  std::vector<float> resampleBuf;
  UINT32 outSampleRate = 16000;
  UINT32 outChannels = 1;
  std::atomic<bool> stopFlag{ false };
  std::thread captureThread;
  uv_async_t async_handle;
  uv_loop_t* loop = nullptr;
  Napi::FunctionReference jsCallback;
  std::queue<CallbackPayload*> queue;
  std::mutex queueMutex;
  std::atomic<bool> closing{ false };
};

struct RenderCaptureDevice {
  IAudioClient* client = nullptr;
  IAudioCaptureClient* capture = nullptr;
  WAVEFORMATEX* mixFormat = nullptr;
  UINT32 inFrameSize = 0;
  UINT32 inChannels = 0;
  UINT32 inSampleRate = 0;
  bool inFloat = false;
  DWORD lastNonSilentTick = 0;
};

static float sampleToFloat(const uint8_t* p, bool isFloat, UINT32 ch) {
  if (isFloat) {
    return *reinterpret_cast<const float*>(p + ch * sizeof(float));
  }
  int16_t s = *reinterpret_cast<const int16_t*>(p + ch * sizeof(int16_t));
  return s / 32768.f;
}

static void downmixAndResample(
  const uint8_t* inData,
  UINT32 inFrames,
  RenderCaptureDevice* dev,
  CaptureContext* ctx,
  std::vector<int16_t>& out
) {
  UINT32 inCh = dev->inChannels;
  UINT32 inSr = dev->inSampleRate;
  UINT32 outSr = ctx->outSampleRate;
  bool isFloat = dev->inFloat;
  UINT32 frameBytes = dev->inFrameSize;

  out.clear();
  if (inFrames == 0) return;

  // Downmix to mono: average all channels
  std::vector<float>& mono = ctx->resampleBuf;
  mono.resize(inFrames);
  for (UINT32 i = 0; i < inFrames; i++) {
    float sum = 0;
    for (UINT32 c = 0; c < inCh; c++)
      sum += sampleToFloat(inData + i * frameBytes, isFloat, c);
    mono[i] = sum / (float)inCh;
  }

  // Resample to outSr (linear interpolation)
  double ratio = (double)inSr / (double)outSr;
  size_t outFrames = (size_t)(inFrames / ratio + 0.5);
  if (outFrames == 0) return;
  out.resize(outFrames);

  for (size_t j = 0; j < outFrames; j++) {
    double srcIdx = j * ratio;
    size_t i0 = (size_t)srcIdx;
    size_t i1 = i0 + 1;
    float f = (float)(srcIdx - i0);
    if (i1 >= inFrames) i1 = inFrames - 1;
    float v = mono[i0] * (1.f - f) + mono[i1] * f;
    if (v > 1.f) v = 1.f;
    if (v < -1.f) v = -1.f;
    out[j] = (int16_t)(v * 32767.f);
  }
}

static bool hasAudibleSamples(const std::vector<int16_t>& samples) {
  if (samples.empty()) return false;
  double sum = 0.0;
  for (int16_t s : samples) {
    sum += std::abs((int)s) / 32768.0;
  }
  return (sum / (double)samples.size()) > 0.0005;
}

static void enqueuePcm(CaptureContext* ctx, const std::vector<int16_t>& pcm) {
  if (!ctx || pcm.empty()) return;
  size_t byteLen = pcm.size() * sizeof(int16_t);
  CallbackPayload* payload = new CallbackPayload();
  payload->data = (uint8_t*)malloc(byteLen);
  payload->length = byteLen;
  if (payload->data) {
    memcpy(payload->data, pcm.data(), byteLen);
    {
      std::lock_guard<std::mutex> lock(ctx->queueMutex);
      ctx->queue.push(payload);
    }
    uv_async_send(&ctx->async_handle);
  } else {
    delete payload;
  }
}

static bool alreadyOpenedEndpoint(const std::vector<std::wstring>& ids, const std::wstring& id) {
  for (const auto& existing : ids) {
    if (existing == id) return true;
  }
  return false;
}

static bool openDefaultRenderRole(
  IMMDeviceEnumerator* enumerator,
  ERole role,
  std::vector<std::wstring>& openedEndpointIds,
  RenderCaptureDevice& out
) {
  IMMDevice* device = nullptr;
  HRESULT hr = enumerator->GetDefaultAudioEndpoint(eRender, role, &device);
  if (FAILED(hr) || !device) return false;

  LPWSTR endpointId = nullptr;
  hr = device->GetId(&endpointId);
  if (FAILED(hr) || !endpointId) {
    device->Release();
    return false;
  }

  std::wstring id(endpointId);
  CoTaskMemFree(endpointId);
  if (alreadyOpenedEndpoint(openedEndpointIds, id)) {
    device->Release();
    return false;
  }

  IAudioClient* client = nullptr;
  hr = device->Activate(IID_IAudioClient, CLSCTX_ALL, nullptr, (void**)&client);
  device->Release();
  if (FAILED(hr) || !client) return false;

  WAVEFORMATEX* mixFormat = nullptr;
  hr = client->GetMixFormat(&mixFormat);
  if (FAILED(hr) || !mixFormat) {
    client->Release();
    return false;
  }

  REFERENCE_TIME bufDuration = 10000000;
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, bufDuration, 0, mixFormat, nullptr);
  if (FAILED(hr)) {
    CoTaskMemFree(mixFormat);
    client->Release();
    return false;
  }

  IAudioCaptureClient* capture = nullptr;
  hr = client->GetService(IID_IAudioCaptureClient, (void**)&capture);
  if (FAILED(hr) || !capture) {
    CoTaskMemFree(mixFormat);
    client->Release();
    return false;
  }

  hr = client->Start();
  if (FAILED(hr)) {
    capture->Release();
    CoTaskMemFree(mixFormat);
    client->Release();
    return false;
  }

  out.client = client;
  out.capture = capture;
  out.mixFormat = mixFormat;
  out.inFrameSize = mixFormat->nBlockAlign;
  out.inChannels = mixFormat->nChannels;
  out.inSampleRate = mixFormat->nSamplesPerSec;
  out.inFloat = (mixFormat->wFormatTag == WAVE_FORMAT_EXTENSIBLE)
    ? (reinterpret_cast<WAVEFORMATEXTENSIBLE*>(mixFormat)->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT)
    : (mixFormat->wFormatTag == WAVE_FORMAT_IEEE_FLOAT);
  openedEndpointIds.push_back(id);
  return true;
}

static void openAllActiveRenderEndpoints(
  IMMDeviceEnumerator* enumerator,
  std::vector<std::wstring>& openedEndpointIds,
  std::vector<RenderCaptureDevice>& devices
) {
  IMMDeviceCollection* collection = nullptr;
  HRESULT hr = enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &collection);
  if (FAILED(hr) || !collection) return;

  UINT count = 0;
  hr = collection->GetCount(&count);
  if (FAILED(hr)) {
    collection->Release();
    return;
  }

  for (UINT i = 0; i < count; i++) {
    IMMDevice* device = nullptr;
    hr = collection->Item(i, &device);
    if (FAILED(hr) || !device) continue;

    LPWSTR endpointId = nullptr;
    hr = device->GetId(&endpointId);
    if (FAILED(hr) || !endpointId) {
      device->Release();
      continue;
    }

    std::wstring id(endpointId);
    CoTaskMemFree(endpointId);
    if (alreadyOpenedEndpoint(openedEndpointIds, id)) {
      device->Release();
      continue;
    }

    IAudioClient* client = nullptr;
    hr = device->Activate(IID_IAudioClient, CLSCTX_ALL, nullptr, (void**)&client);
    device->Release();
    if (FAILED(hr) || !client) continue;

    WAVEFORMATEX* mixFormat = nullptr;
    hr = client->GetMixFormat(&mixFormat);
    if (FAILED(hr) || !mixFormat) {
      client->Release();
      continue;
    }

    REFERENCE_TIME bufDuration = 10000000;
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, bufDuration, 0, mixFormat, nullptr);
    if (FAILED(hr)) {
      CoTaskMemFree(mixFormat);
      client->Release();
      continue;
    }

    IAudioCaptureClient* capture = nullptr;
    hr = client->GetService(IID_IAudioCaptureClient, (void**)&capture);
    if (FAILED(hr) || !capture) {
      CoTaskMemFree(mixFormat);
      client->Release();
      continue;
    }

    hr = client->Start();
    if (FAILED(hr)) {
      capture->Release();
      CoTaskMemFree(mixFormat);
      client->Release();
      continue;
    }

    RenderCaptureDevice out;
    out.client = client;
    out.capture = capture;
    out.mixFormat = mixFormat;
    out.inFrameSize = mixFormat->nBlockAlign;
    out.inChannels = mixFormat->nChannels;
    out.inSampleRate = mixFormat->nSamplesPerSec;
    out.inFloat = (mixFormat->wFormatTag == WAVE_FORMAT_EXTENSIBLE)
      ? (reinterpret_cast<WAVEFORMATEXTENSIBLE*>(mixFormat)->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT)
      : (mixFormat->wFormatTag == WAVE_FORMAT_IEEE_FLOAT);
    openedEndpointIds.push_back(id);
    devices.push_back(out);
  }

  collection->Release();
}

static void closeRenderDevice(RenderCaptureDevice& dev) {
  if (dev.client) dev.client->Stop();
  if (dev.capture) dev.capture->Release();
  if (dev.mixFormat) CoTaskMemFree(dev.mixFormat);
  if (dev.client) dev.client->Release();
  dev.client = nullptr;
  dev.capture = nullptr;
  dev.mixFormat = nullptr;
}

static void onAsync(uv_async_t* handle) {
  CaptureContext* ctx = static_cast<CaptureContext*>(handle->data);
  if (!ctx || ctx->closing) return;
  std::queue<CallbackPayload*> drain;
  {
    std::lock_guard<std::mutex> lock(ctx->queueMutex);
    drain.swap(ctx->queue);
  }
  while (!drain.empty()) {
    CallbackPayload* payload = drain.front();
    drain.pop();
    if (payload && payload->data && payload->length && !ctx->jsCallback.IsEmpty()) {
      Napi::Env env = ctx->jsCallback.Env();
      Napi::HandleScope scope(env);
      Napi::Buffer<uint8_t> buf = Napi::Buffer<uint8_t>::Copy(env, payload->data, payload->length);
      ctx->jsCallback.Call({ buf });
      free(payload->data);
    }
    delete payload;
  }
  if (ctx->closing) {
    uv_close(reinterpret_cast<uv_handle_t*>(handle), [](uv_handle_t* h) {
      CaptureContext* c = static_cast<CaptureContext*>(h->data);
      delete c;
    });
  }
}

static CaptureContext* g_captureCtx = nullptr;

static void captureThreadFn(CaptureContext* ctx) {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);

  IMMDeviceEnumerator* enumerator = nullptr;
  HRESULT hr;

  hr = CoCreateInstance(CLSID_MMDeviceEnumerator, nullptr, CLSCTX_ALL, IID_IMMDeviceEnumerator, (void**)&enumerator);
  if (FAILED(hr) || !enumerator) {
    CoUninitialize();
    return;
  }

  std::vector<std::wstring> openedEndpointIds;
  std::vector<RenderCaptureDevice> devices;
  const ERole roles[] = { eConsole, eMultimedia, eCommunications };
  for (ERole role : roles) {
    RenderCaptureDevice dev;
    if (openDefaultRenderRole(enumerator, role, openedEndpointIds, dev)) {
      devices.push_back(dev);
    }
  }
  openAllActiveRenderEndpoints(enumerator, openedEndpointIds, devices);
  enumerator->Release();
  if (devices.empty()) {
    CoUninitialize();
    return;
  }

  while (!ctx->stopFlag) {
    bool sawData = false;

    for (auto& dev : devices) {
      BYTE* pData = nullptr;
      UINT32 numFrames = 0;
      DWORD flags = 0;
      UINT64 devPos = 0, qpcPos = 0;
      hr = dev.capture->GetBuffer(&pData, &numFrames, &flags, &devPos, &qpcPos);
      if (hr == AUDCLNT_S_BUFFER_EMPTY) continue;
      if (FAILED(hr)) continue;

      sawData = true;
      if (numFrames > 0) {
        if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) || !pData) {
          double ratio = (double)ctx->outSampleRate / (double)dev.inSampleRate;
          size_t outFrames = (size_t)(numFrames * ratio + 0.5);
          ctx->outBuf.assign(outFrames, 0);
        } else {
          downmixAndResample(pData, numFrames, &dev, ctx, ctx->outBuf);
        }

        const bool audible = hasAudibleSamples(ctx->outBuf);
        const DWORD nowTick = GetTickCount();
        if (audible) {
          dev.lastNonSilentTick = nowTick;
          enqueuePcm(ctx, ctx->outBuf);
        } else if (dev.lastNonSilentTick != 0 && nowTick - dev.lastNonSilentTick < 1500) {
          enqueuePcm(ctx, ctx->outBuf);
        }
      }
      dev.capture->ReleaseBuffer(numFrames);
    }

    if (!sawData) {
      Sleep(5);
    }
  }

  for (auto& dev : devices) {
    closeRenderDevice(dev);
  }

  CoUninitialize();
}

static Napi::Value StartLoopbackCapture(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2) {
    Napi::TypeError::New(env, "Expected (options, callback)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (!info[0].IsObject() || !info[1].IsFunction()) {
    Napi::TypeError::New(env, "Expected (options object, onAudioData function)").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Object opts = info[0].As<Napi::Object>();
  uint32_t sampleRate = 16000;
  if (opts.Has("sampleRate")) sampleRate = opts.Get("sampleRate").As<Napi::Number>().Uint32Value();
  uint32_t channels = 1;
  if (opts.Has("channels")) channels = opts.Get("channels").As<Napi::Number>().Uint32Value();

  uv_loop_t* loop = nullptr;
  napi_status loopStatus = napi_get_uv_event_loop(env, &loop);
  if (loopStatus != napi_ok || !loop) {
    Napi::Error::New(env, "napi_get_uv_event_loop failed").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  CaptureContext* ctx = new CaptureContext();
  ctx->outSampleRate = sampleRate;
  ctx->outChannels = channels;
  ctx->loop = loop;
  ctx->jsCallback = Napi::Persistent(info[1].As<Napi::Function>());
  ctx->async_handle.data = ctx;
  if (uv_async_init(loop, &ctx->async_handle, onAsync) != 0) {
    delete ctx;
    Napi::Error::New(env, "uv_async_init failed").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if (g_captureCtx) {
    CaptureContext* old = g_captureCtx;
    g_captureCtx = nullptr;
    old->stopFlag = true;
    if (old->captureThread.joinable()) old->captureThread.join();
    old->closing = true;
    uv_async_send(&old->async_handle);
  }
  g_captureCtx = ctx;
  ctx->captureThread = std::thread(captureThreadFn, ctx);
  return env.Undefined();
}

static Napi::Value StopLoopbackCapture(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  CaptureContext* ctx = g_captureCtx;
  g_captureCtx = nullptr;
  if (!ctx) return env.Undefined();
  ctx->stopFlag = true;
  if (ctx->captureThread.joinable())
    ctx->captureThread.join();
  ctx->closing = true;
  uv_async_send(&ctx->async_handle);
  return env.Undefined();
}

#endif // _WIN32

namespace {

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
#ifdef _WIN32
  exports.Set("startLoopbackCapture", Napi::Function::New(env, StartLoopbackCapture));
  exports.Set("stopLoopbackCapture", Napi::Function::New(env, StopLoopbackCapture));
#else
  (void)exports;
#endif
  return exports;
}

NODE_API_MODULE(wasapi_loopback, Init)

}  // namespace

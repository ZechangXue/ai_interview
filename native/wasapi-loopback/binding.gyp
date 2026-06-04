{
  "targets": [{
    "target_name": "wasapi_loopback",
    "sources": [ "wasapi_loopback.cpp" ],
    "include_dirs": [
      "<!@(node -p \"require('node-addon-api').include\")"
    ],
    "dependencies": [ "<!(node -p \"require('node-addon-api').gyp\")" ],
    "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
    "conditions": [
      ["OS=='win'", {
        "libraries": [ "-lole32", "-luser32" ],
        "msvs_settings": {
          "VCCLCompilerTool": { "ExceptionHandling": 1 }
        }
      }],
      ["OS!='win'", {
        "sources": []
      }]
    ]
  }]
}

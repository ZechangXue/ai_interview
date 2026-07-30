# SCALA Technical Roadmap and Hard-Questions FAQ (English)

## Technical Roadmap Overview

| Module / Stage | What We Are Doing (Goal) | Method (How We Do It) |
|---|---|---|
| Overall pipeline | Build an interpretable and auditable training-assessment workflow for laparoscopic cholecystectomy | A layered pipeline: **Segmentation → State Modeling → Event Proposal → VLM Judgment → Report Generation** |
| Frontend (Web UI) | Provide upload, progress tracking, result visualization, and report export for surgeons/trainers | **HTML + CSS + vanilla JavaScript** (templates in `webapp/templates`, logic in `webapp/static/*.js`), calling FastAPI via `fetch`; frontend handles polling, clip display, and report rendering |
| Backend (Service layer) | Handle upload, task orchestration, segmentation calls, state export, and API coordination | **FastAPI + Uvicorn + Pydantic** with `BackgroundTasks`/`asyncio` for async jobs; centralized job-state and artifact management |
| Video processing layer | Convert uploaded videos into a stable analysis stream | **OpenCV + NumPy** for decode/encode, FPS normalization, frame processing, overlay rendering, and sample-frame export |
| Segmentation core | Convert raw surgical images into structured semantic signals | **PyTorch + segmentation_models_pytorch**, with **FPN + EfficientNet-B4**, performing **13-class semantic segmentation** |
| Frame-level inference | Detect tissues/instruments/bleeding semantics at each frame | Per-frame class map prediction (softmax + argmax), with mask/overlay generation and per-class pixel statistics |
| Quality feature layer | Add image-quality signal for downstream reliability | Compute **clarity score** (Laplacian-variance normalization) as a visual-quality signal |
| Frame-state modeling | Decouple downstream logic from raw images | Build per-frame structured state (visibility, bbox, pixel_count, geometry, timestamp), serialized to JSON-friendly format |
| Temporal robustness | Reduce sensitivity to single-frame false positives | Apply temporal post-processing: minimum-duration thresholds, isolated-frame filtering, and overlap suppression |
| Calot key-event proposal | Prioritize the most informative evidence windows | Rule-based event proposal from state (exposure progress, bleeding, risky energy usage, etc.) |
| VLM layer (vision-language judgment) | Perform high-level semantic and coaching-oriented interpretation on key clips | Use OpenAI multimodal capability via `webapp/vlm_api.py`; current project setup primarily uses **GPT-4o family (including mini)** with clip + state joint reasoning |
| Report generation | Produce structured, training-oriented feedback | Aggregate visibility/safety/efficiency signals into evidence-grounded assessment reports |
| Engineering reliability | Keep the system usable and responsive | Model preloading + caching, async background execution, progress polling, and standardized artifacts (demo video + state JSON) |

---

## Hard-Questions FAQ (10 Q&A)

### 1) Why not send the full video directly to a VLM and stop there?
**A:** Pure VLM workflows are costly, less stable in temporal localization, and weaker in interpretability. We first extract structured events from segmentation (visibility/bleeding/instrument/clarity), then let VLM focus on key clips for better reliability and auditability.

### 2) Why standardize to 10 FPS? Do we lose information?
**A:** The target is training assessment, not micro-motion trajectory reconstruction. 10 FPS preserves key procedural-stage information while significantly reducing compute cost and temporal jitter.

### 3) Why FPN + EfficientNet-B4 instead of a larger model?
**A:** It is a practical balance across accuracy, latency, and VRAM. We optimize for scalable, deployable, reproducible operation rather than single-case peak scores.

### 4) Why use rule-threshold events instead of fully learned event detection?
**A:** Rule-based events are interpretable, auditable, and fast to iterate, which is especially important in clinical training settings. Learning-based modules can be added later on top.

### 5) Why keep `frame_state_cache` instead of discarding after inference?
**A:** Reports, Q&A, and playback repeatedly access the same frame states. Caching enables reuse and significantly reduces repeated computation and latency.

### 6) What is the essential difference between `main_demo_cv` and `main_demo_cv_share`?
**A:** The algorithmic pipeline is the same. Differences are mostly entry routes, upload compatibility (e.g., webm), and presentation positioning.

### 7) Why propose clips from segmentation first, then run VLM?
**A:** It narrows the candidate space to high-value windows, so VLM budget is spent on the most informative evidence, improving both stability and cost efficiency.

### 8) What if segmentation is wrong on a frame?
**A:** We apply temporal consistency filtering, minimum-duration constraints, and overlap-based event deduplication to reduce single-frame errors impacting the final report.

### 9) Why output both overlay and original videos?
**A:** Overlay supports interpretability for demonstration; original frames support vision-model input and human review, avoiding bias from relying only on overlays.

### 10) What is the biggest engineering gain of this architecture?
**A:** Interpretability, auditability, and modular extensibility: segmentation, event logic, and VLM layers can evolve independently without tight coupling.

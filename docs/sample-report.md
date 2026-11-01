# Aether architecture report

> repo `.` — generated 2026-11-01T02:25:11.393Z
> model `local-architect` · 38 files · 5120 lines · 66 edges

## Architecture (local analysis)

The repository contains **38 modules** and **5120 lines**, wired by **66 internal imports**.

### Load-bearing modules
- `packages/aether-core/src/effect.ts` — 7 dependents, 4 imports
- `packages/aether-core/src/utils.ts` — 6 dependents, 0 imports
- `packages/aether-core/src/graph-channel.ts` — 5 dependents, 1 imports
- `packages/aether-llm/src/types.ts` — 5 dependents, 0 imports
- `packages/aether-core/src/graph.ts` — 4 dependents, 4 imports
- `packages/aether-llm/src/client.ts` — 4 dependents, 4 imports
- `packages/aether-core/src/dep.ts` — 4 dependents, 1 imports
- `packages/aether-llm/src/rate-limiter.ts` — 4 dependents, 0 imports

### Suggested layering
1. **State layer** — pure data modules, imported by many, importing nothing.
2. **Derivation layer** — imports state and exports pure functions.
3. **Effect layer** — entrypoints that perform I/O and are imported by nobody.

### Risks
- No structural red flags detected at this resolution.

### Dependency sketch
```mermaid
flowchart LR
  mpackages_aether_core_src_computed_ts["aether-core/src/computed.ts"]
  mpackages_aether_core_src_dep_ts["aether-core/src/dep.ts"]
  mpackages_aether_core_src_effect_ts["aether-core/src/effect.ts"]
  mpackages_aether_core_src_graph_channel_ts["aether-core/src/graph-channel.ts"]
  mpackages_aether_core_src_graph_ts["aether-core/src/graph.ts"]
  mpackages_aether_core_src_index_ts["aether-core/src/index.ts"]
  mpackages_aether_core_src_reactive_ts["aether-core/src/reactive.ts"]
  mpackages_aether_core_src_ref_ts["aether-core/src/ref.ts"]
  mpackages_aether_core_src_scheduler_ts["aether-core/src/scheduler.ts"]
  mpackages_aether_core_src_scope_ts["aether-core/src/scope.ts"]
  mpackages_aether_core_src_trace_ts["aether-core/src/trace.ts"]
  mpackages_aether_core_src_utils_ts["aether-core/src/utils.ts"]
  mpackages_aether_core_src_watch_ts["aether-core/src/watch.ts"]
  mpackages_aether_core_tests_graph_test_ts["aether-core/tests/graph.test.ts"]
  mpackages_aether_core_tests_reactive_test_ts["aether-core/tests/reactive.test.ts"]
  mpackages_aether_demo_src_analyzer_ts["aether-demo/src/analyzer.ts"]
  mpackages_aether_demo_src_index_ts["aether-demo/src/index.ts"]
  mpackages_aether_demo_src_main_ts["aether-demo/src/main.ts"]
  mpackages_aether_demo_src_pipeline_ts["aether-demo/src/pipeline.ts"]
  mpackages_aether_demo_src_tools_ts["aether-demo/src/tools.ts"]
  mpackages_aether_core_src_computed_ts --> mpackages_aether_core_src_dep_ts
  mpackages_aether_core_src_computed_ts --> mpackages_aether_core_src_effect_ts
  mpackages_aether_core_src_computed_ts --> mpackages_aether_core_src_graph_channel_ts
  mpackages_aether_core_src_computed_ts --> mpackages_aether_core_src_graph_ts
  mpackages_aether_core_src_dep_ts --> mpackages_aether_core_src_effect_ts
  mpackages_aether_core_src_effect_ts --> mpackages_aether_core_src_dep_ts
  mpackages_aether_core_src_effect_ts --> mpackages_aether_core_src_graph_channel_ts
  mpackages_aether_core_src_effect_ts --> mpackages_aether_core_src_scope_ts
  mpackages_aether_core_src_effect_ts --> mpackages_aether_core_src_utils_ts
  mpackages_aether_core_src_graph_channel_ts --> mpackages_aether_core_src_graph_ts
  mpackages_aether_core_src_graph_ts --> mpackages_aether_core_src_effect_ts
  mpackages_aether_core_src_graph_ts --> mpackages_aether_core_src_graph_channel_ts
  mpackages_aether_core_src_graph_ts --> mpackages_aether_core_src_scheduler_ts
  mpackages_aether_core_src_graph_ts --> mpackages_aether_core_src_utils_ts
  mpackages_aether_core_src_reactive_ts --> mpackages_aether_core_src_dep_ts
  mpackages_aether_core_src_reactive_ts --> mpackages_aether_core_src_effect_ts
  mpackages_aether_core_src_reactive_ts --> mpackages_aether_core_src_graph_channel_ts
  mpackages_aether_core_src_reactive_ts --> mpackages_aether_core_src_ref_ts
  mpackages_aether_core_src_reactive_ts --> mpackages_aether_core_src_utils_ts
  mpackages_aether_core_src_reactive_ts --> mpackages_aether_core_src_graph_ts
  mpackages_aether_core_src_ref_ts --> mpackages_aether_core_src_dep_ts
  mpackages_aether_core_src_ref_ts --> mpackages_aether_core_src_effect_ts
  mpackages_aether_core_src_ref_ts --> mpackages_aether_core_src_graph_channel_ts
  mpackages_aether_core_src_ref_ts --> mpackages_aether_core_src_reactive_ts
  mpackages_aether_core_src_ref_ts --> mpackages_aether_core_src_utils_ts
  mpackages_aether_core_src_ref_ts --> mpackages_aether_core_src_graph_ts
  mpackages_aether_core_src_scheduler_ts --> mpackages_aether_core_src_utils_ts
  mpackages_aether_core_src_scope_ts --> mpackages_aether_core_src_effect_ts
  mpackages_aether_core_src_watch_ts --> mpackages_aether_core_src_effect_ts
  mpackages_aether_core_src_watch_ts --> mpackages_aether_core_src_scheduler_ts
  mpackages_aether_core_src_watch_ts --> mpackages_aether_core_src_ref_ts
  mpackages_aether_core_src_watch_ts --> mpackages_aether_core_src_reactive_ts
  mpackages_aether_core_src_watch_ts --> mpackages_aether_core_src_utils_ts
  mpackages_aether_core_src_watch_ts --> mpackages_aether_core_src_computed_ts
  mpackages_aether_core_tests_graph_test_ts --> mpackages_aether_core_src_index_ts
  mpackages_aether_core_tests_reactive_test_ts --> mpackages_aether_core_src_index_ts
  mpackages_aether_demo_src_main_ts --> mpackages_aether_demo_src_pipeline_ts
  mpackages_aether_demo_src_pipeline_ts --> mpackages_aether_demo_src_analyzer_ts
  mpackages_aether_demo_src_pipeline_ts --> mpackages_aether_demo_src_tools_ts
  mpackages_aether_demo_src_tools_ts --> mpackages_aether_demo_src_analyzer_ts
```


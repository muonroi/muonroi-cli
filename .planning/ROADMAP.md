# Roadmap: tôi muốn bạn thảo luận và research đánh giá sandbox của cli sau đó so sánh nó vớ

## Overview

Product loop decomposition — 4 phase(s) synced from /ideal phase plan.

## Phases

- [ ] **Phase 1: Research and Comparative Analysis of Existing CLI Sandboxes** - Analyze and compare sandbox implementations of at least 3-5 existing CLI tools (Claude Code, Cursor, Aider, Codex CLI, e
- [ ] **Phase 2: Design Sandbox for muonroi-cli with Role-Based Profiles and Differentiation** - Design a sandbox for muonroi-cli with 3 distinct profiles (Read/Write/Exec) specifying filesystem and process exec permi
- [ ] **Phase 3: Performance Benchmark Planning and Measurement** - Plan and execute a benchmark to measure actual performance overhead of the designed sandbox compared to baseline without
- [ ] **Phase 4: Implementation Plan and Test Strategy** - Develop a concrete implementation plan for the sandbox, including code locations, required dependencies, and a test stra

## Phase Details

### Phase 1: Research and Comparative Analysis of Existing CLI Sandboxes
**Goal**: Analyze and compare sandbox implementations of at least 3-5 existing CLI tools (Claude Code, Cursor, Aider, Codex CLI, etc.) on isolation boundaries, role-based profiles, performance overhead, and deployment complexity.
**Depends on**: Nothing (first phase)
**Success Criteria** (what must be TRUE):
  1. Có phân tích so sánh sandbox của ít nhất 3-5 CLI hiện có (ví dụ Claude Code, Cursor, Aider, Codex CLI, v.v.) trên các trục: ranh giới cô lập, profile theo role, performance overhead, độ phức tạp triển khai
**Plans**: TBD

Plans:
- [ ] 01-01: Sprint scope for Research and Comparative Analysis of Existing CLI Sandboxes

### Phase 2: Design Sandbox for muonroi-cli with Role-Based Profiles and Differentiation
**Goal**: Design a sandbox for muonroi-cli with 3 distinct profiles (Read/Write/Exec) specifying filesystem and process exec permissions per phase. Ensure design fits existing monorepo structure. Demonstrate that the concept of 'sandbox profile according to role phase' is different from existing CLIs.
**Depends on**: Phase 1
**Success Criteria** (what must be TRUE):
  1. Đề xuất được design sandbox cho muonroi-cli với 3 profile riêng biệt cho Read/Write/Exec phase, mô tả rõ quyền filesystem và process exec mỗi phase
  2. Design phù hợp với kiến trúc monorepo hiện tại (packages/, src/orchestrator/, src/providers/, agent-harness-*)
  3. Trục khác biệt 'sandbox profile theo role phase' được chứng minh là khác biệt so với các CLI đang có
**Plans**: TBD

Plans:
- [ ] 02-01: Sprint scope for Design Sandbox for muonroi-cli with Role-Based Profiles and Differentiation

### Phase 3: Performance Benchmark Planning and Measurement
**Goal**: Plan and execute a benchmark to measure actual performance overhead of the designed sandbox compared to baseline without sandbox. Ensure measured overhead is below 10%. Document the measurement method.
**Depends on**: Phase 2
**Success Criteria** (what must be TRUE):
  1. Performance overhead thực tế đo được < 10% (có phương pháp đo và benchmark)
**Plans**: TBD

Plans:
- [ ] 03-01: Sprint scope for Performance Benchmark Planning and Measurement

### Phase 4: Implementation Plan and Test Strategy
**Goal**: Develop a concrete implementation plan for the sandbox, including code locations, required dependencies, and a test strategy.
**Depends on**: Phase 3
**Success Criteria** (what must be TRUE):
  1. Có kế hoạch triển khai cụ thể: vị trí code, dependency cần thêm, test strategy
**Plans**: TBD

Plans:
- [ ] 04-01: Sprint scope for Implementation Plan and Test Strategy


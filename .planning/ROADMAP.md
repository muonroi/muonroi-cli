# Roadmap: migrate the gsd workflow engine off the external @opengsd/gsd-core dependency to

## Overview

Product loop decomposition — 4 phase(s) synced from /ideal phase plan.

## Phases

- [ ] **Phase 1: Discovery & Baseline** - Understand current dependency usage, document API, and set up test harness to measure equivalence.
- [ ] **Phase 2: Core Engine Implementation** - Implement the native workflow engine in src/council/ that replicates the behavior of @opengsd/gsd-core, using the existi
- [ ] **Phase 3: Integration & Developer Experience** - Replace all references to external dependency in the consumer app, integrate with the new engine, and ensure developers 
- [ ] **Phase 4: Performance & Decommission** - Validate performance scales from 1 to 100 concurrent workflows, finalize removal of the dependency, and ensure productio

## Phase Details

### Phase 1: Discovery & Baseline
**Goal**: Understand current dependency usage, document API, and set up test harness to measure equivalence.
**Depends on**: Nothing (first phase)
**Success Criteria** (what must be TRUE):
**Plans**: TBD

Plans:
- [ ] 01-01: Sprint scope for Discovery & Baseline

### Phase 2: Core Engine Implementation
**Goal**: Implement the native workflow engine in src/council/ that replicates the behavior of @opengsd/gsd-core, using the existing council module for orchestration.
**Depends on**: Phase 1
**Success Criteria** (what must be TRUE):
**Plans**: TBD

Plans:
- [ ] 02-01: Sprint scope for Core Engine Implementation

### Phase 3: Integration & Developer Experience
**Goal**: Replace all references to external dependency in the consumer app, integrate with the new engine, and ensure developers using BYOK AI coding agent can seamlessly use the system.
**Depends on**: Phase 2
**Success Criteria** (what must be TRUE):
  1. Persona: Developers using the BYOK AI coding agent
**Plans**: TBD

Plans:
- [ ] 03-01: Sprint scope for Integration & Developer Experience

### Phase 4: Performance & Decommission
**Goal**: Validate performance scales from 1 to 100 concurrent workflows, finalize removal of the dependency, and ensure production readiness.
**Depends on**: Phase 3
**Success Criteria** (what must be TRUE):
  1. Scale: 1-100
**Plans**: TBD

Plans:
- [ ] 04-01: Sprint scope for Performance & Decommission


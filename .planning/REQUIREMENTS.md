# Requirements: muonroi-cli

**Defined:** 2026-05-01
**Core Value:** Sell the orchestration intelligence (memory + router + cap + compaction) that stretches BYOK tokens 2-3x further than any subscription-locked tool.

## v1.2 Requirements

Requirements for closing the EE learning loop. Each maps to roadmap phases.

### Session Extraction

- [x] **EXTRACT-01**: CLI calls /api/extract with session transcript when session ends (cleanup/SIGINT)
- [x] **EXTRACT-02**: Transcript is compacted before sending to extract (reuse existing compaction logic)
- [x] **EXTRACT-03**: Extraction is fire-and-forget — does not block CLI shutdown beyond 2s
- [x] **EXTRACT-04**: Extraction skipped if session < 5 messages (no meaningful content)

### Offline Queue

- [x] **QUEUE-01**: EE client buffers failed requests to local queue when server unreachable
- [x] **QUEUE-02**: Queue persists on disk (~/.muonroi-cli/ee-offline-queue/)
- [x] **QUEUE-03**: Queue replays automatically when EE server becomes reachable again
- [x] **QUEUE-04**: Queue has max size cap (100 entries) to prevent unbounded growth
- [x] **QUEUE-05**: Heavy events (extract) drain separately in background

### Prompt-stale Reconciliation

- [x] **STALE-01**: PIL Layer 3 tracks suggestions injected into prompt
- [x] **STALE-02**: After each turn, call /api/prompt-stale for suggestions not used by agent
- [x] **STALE-03**: Reconciliation is async fire-and-forget (does not block next turn)

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Deeper EE Integration

- **DEEP-01**: Local mistake detection in CLI (mirror EE's 5 pattern detector)
- **DEEP-02**: CLI-triggered evolution cycle after N sessions
- **DEEP-03**: Principle sharing between CLI instances via portable JSON

## Out of Scope

| Feature | Reason |
|---------|--------|
| Local EE brain (embedded) | CLI uses EE via HTTP/bridge — embedding the full brain is a v2+ concern |
| Shell bootstrap integration | CLI has its own `doctor` command; EE shell bootstrap is for standalone EE |
| Multi-user isolation | Single-user CLI; multi-user is a cloud/SaaS concern |
| EE admin tools (demote, seed, dogfood) | These are EE-side tools, not CLI concerns |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| EXTRACT-01 | Phase 08 | Complete |
| EXTRACT-02 | Phase 08 | Complete |
| EXTRACT-03 | Phase 08 | Complete |
| EXTRACT-04 | Phase 08 | Complete |
| QUEUE-01 | Phase 09 | Complete |
| QUEUE-02 | Phase 09 | Complete |
| QUEUE-03 | Phase 09 | Complete |
| QUEUE-04 | Phase 09 | Complete |
| QUEUE-05 | Phase 09 | Complete |
| STALE-01 | Phase 10 | Complete |
| STALE-02 | Phase 10 | Complete |
| STALE-03 | Phase 10 | Complete |

**Coverage:**
- v1.2 requirements: 12 total
- Mapped to phases: 12
- Unmapped: 0

---
*Requirements defined: 2026-05-01*
*Last updated: 2026-05-01 after roadmap creation*

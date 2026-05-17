import { isPlatformBrowser } from "@angular/common";
import { Injectable, inject, NgZone, PLATFORM_ID } from "@angular/core";
import type { LiveFrame, WebSocketTransport } from "@muonroi/agent-harness-core";
import { interval, type Subscription } from "rxjs";
import { SemanticRegistryService } from "./registry.service.js";

const PROTOCOL_VERSION = "0.2.0" as const;

/**
 * SemanticSnapshotService — runs outside Angular zone.
 *
 * Polls the SemanticRegistryService at `fps` Hz (default 30 = 33ms interval),
 * deduplicates via JSON hash, and sends distinct LiveFrame snapshots via the
 * provided WebSocketTransport.
 *
 * ## SSR safety (Task 4.6a)
 *
 * If the PLATFORM_ID is not "browser" (i.e., SSR/server environment),
 * the start() method is a no-op — no WebSocket or setInterval is created.
 * This ensures Angular Universal / SSR apps don't throw on missing browser APIs.
 *
 * ## Zone safety (Task 4.6)
 *
 * The RxJS interval is scheduled via NgZone.runOutsideAngular so that the
 * polling timer does NOT trigger unnecessary Angular change detection cycles.
 */
@Injectable({ providedIn: "root" })
export class SemanticSnapshotService {
  private readonly zone = inject(NgZone);
  private readonly registry = inject(SemanticRegistryService);
  private readonly platformId = inject(PLATFORM_ID);

  private subscription: Subscription | null = null;
  private seq = 0;
  private lastHash = "";

  /**
   * Start the snapshot flush loop.
   *
   * @param transport  WebSocketTransport to send frames on.
   * @param fps        Frames per second (default 30; maps to ~33ms interval).
   */
  start(transport: WebSocketTransport, fps = 30): void {
    // SSR guard (Task 4.6a): no WebSocket or timer in server environments.
    if (!isPlatformBrowser(this.platformId)) return;

    if (this.subscription) {
      // Already running — ignore.
      return;
    }

    const intervalMs = Math.round(1000 / fps);

    // Schedule outside Angular zone to avoid triggering change detection.
    this.zone.runOutsideAngular(() => {
      this.subscription = interval(intervalMs).subscribe(() => {
        const snap = this.registry.snapshot();
        const hash = JSON.stringify(snap.nodes);

        // Hash-dedup: skip if the tree hasn't changed.
        if (hash === this.lastHash) return;
        this.lastHash = hash;

        const frame: LiveFrame = {
          mode: "live",
          version: PROTOCOL_VERSION,
          seq: ++this.seq,
          ts: Date.now(),
          nodes: snap.nodes,
          focus: snap.focus,
          modals: snap.modals,
        };

        // Wrap in the WS envelope (dir: "frame") before sending.
        const envelope = JSON.stringify({ dir: "frame", ...frame });
        transport.send(envelope);
      });
    });
  }

  /** Stop the snapshot loop and reset state. */
  stop(): void {
    this.subscription?.unsubscribe();
    this.subscription = null;
    this.lastHash = "";
  }
}

export type IdleDetector = {
  markActivity: () => void;
  dispose: () => void;
};

export function createIdleDetector(opts: { quiescenceMs: number; onIdle: () => void }): IdleDetector {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    timer = null;
    opts.onIdle();
  };
  const markActivity = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, opts.quiescenceMs);
  };
  return {
    markActivity,
    dispose: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export type HeuristicIdleDetector = {
  markFrame: () => void;
  markStreamDelta: () => void;
  dispose: () => void;
};

export function createHeuristicIdleDetector(opts: {
  frameQuietMs: number;
  streamQuietMs: number;
  onIdle: () => void;
}): HeuristicIdleDetector {
  let lastFrame = -Infinity;
  let lastStream = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const check = () => {
    const now = Date.now();
    if (now - lastFrame >= opts.frameQuietMs && now - lastStream >= opts.streamQuietMs) {
      opts.onIdle();
    } else {
      schedule();
    }
  };

  function schedule() {
    if (timer) clearTimeout(timer);
    const now = Date.now();
    const next = Math.max(opts.frameQuietMs - (now - lastFrame), opts.streamQuietMs - (now - lastStream), 5);
    timer = setTimeout(check, next);
  }

  return {
    markFrame: () => {
      lastFrame = Date.now();
      schedule();
    },
    markStreamDelta: () => {
      lastStream = Date.now();
      schedule();
    },
    dispose: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * src/ui/status-bar/tier-badge.tsx
 *
 * Tier badge sub-component: color-coded tier label with blink on degraded.
 * Color mapping: hot=green, warm=cyan, cold=magenta, degraded=yellow blink.
 */

import * as React from 'react';

export interface TierBadgeProps {
  tier: 'hot' | 'warm' | 'cold' | 'degraded';
}

const COLOR: Record<TierBadgeProps['tier'], string> = {
  hot: 'green',
  warm: 'cyan',
  cold: 'magenta',
  degraded: 'yellow',
};

export function TierBadge({ tier }: TierBadgeProps): React.ReactElement {
  const color = COLOR[tier];
  const blink = tier === 'degraded';
  return React.createElement(
    'text',
    { color, blink: blink || undefined, 'data-testid': 'tier-badge', 'data-tier': tier },
    tier,
  );
}

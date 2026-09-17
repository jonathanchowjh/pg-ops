import type { SubNavItem } from '@/components/sub-nav';

/**
 * The Cleanup tab's sections, in one place.
 *
 * Four files render this strip — the tab and its three sub-routes — and a
 * `SubNav` that disagrees with its siblings is a nav that changes shape as
 * you move through it, which reads as a bug in the page you happen to be on.
 * test/cleanup-subroutes.test.tsx asserts all four carry the same four links.
 */
export const CLEANUP_SECTIONS: readonly SubNavItem[] = [
  { segment: 'space', label: 'Space' },
  { segment: 'maintenance', label: 'Maintenance' },
  { segment: 'sequences', label: 'Sequences' },
];

/**
 * Drop actions whose `type` is not a real {@link ActionType} at a storage
 * boundary.
 *
 * A single malformed action is enough to make `validateScene` reject an entire
 * scene, and the document store rejects the entire document when any scene is
 * invalid — so one stray action taken from model output blocks a whole
 * classroom from being claimed into the courseware library.
 *
 * Newly generated content is filtered at the source (`parseActionsFromStructuredOutput`
 * and `buildCompleteScene` both drop unknown types), so this repair exists for
 * content that was already persisted before those guards — files written by an
 * older build, or a job that was interrupted mid-write. Repairing on read keeps
 * the historical data usable instead of leaving it permanently unclaimable.
 */

import { isActionType } from '@openmaic/dsl';

/** Return a copy of `scenes` with every scene's unknown-typed actions removed. */
export function dropUnknownActions<T extends { id?: unknown; actions?: unknown[] }>(
  scenes: readonly T[],
): { scenes: T[]; dropped: number } {
  let dropped = 0;
  const repaired = scenes.map((scene) => {
    if (!Array.isArray(scene.actions)) return scene;
    const actions = scene.actions.filter((action) => {
      const type = (action as { type?: unknown } | null | undefined)?.type;
      const keep = isActionType(type);
      if (!keep) dropped += 1;
      return keep;
    });
    return actions.length === scene.actions.length ? scene : { ...scene, actions };
  });
  return { scenes: repaired, dropped };
}

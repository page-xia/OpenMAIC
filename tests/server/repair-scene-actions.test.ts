import { describe, expect, it } from 'vitest';
import { dropUnknownActions } from '@/lib/server/repair-scene-actions';

describe('dropUnknownActions', () => {
  it('removes actions with unknown, missing, or non-string types', () => {
    const { scenes, dropped } = dropUnknownActions([
      {
        id: 'scene_1',
        actions: [
          { id: 'a1', type: 'speech', text: 'hi' },
          { id: 'a2', type: 'action' },
          { id: 'a3' },
          { id: 'a4', type: 42 },
        ],
      },
    ]);
    expect(dropped).toBe(3);
    expect(scenes[0].actions?.map((a) => (a as { id: string }).id)).toEqual(['a1']);
  });

  it('returns the same scene objects when nothing needs repair', () => {
    const scene = { id: 'scene_1', actions: [{ id: 'a1', type: 'speech' }] };
    const { scenes, dropped } = dropUnknownActions([scene]);
    expect(dropped).toBe(0);
    expect(scenes[0]).toBe(scene);
  });

  it('leaves scenes without an actions array untouched', () => {
    const scene = { id: 'scene_1' };
    expect(dropUnknownActions([scene]).scenes[0]).toBe(scene);
  });
});

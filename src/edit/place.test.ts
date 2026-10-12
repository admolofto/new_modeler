import { describe, expect, it } from 'vitest';
import type { V3 } from '../geometry/types';
import { emptyDoc } from '../model/defaults';
import { applyOps } from '../model/ops';
import { inches } from '../model/units';
import { worldBoxes } from '../model/world';
import '../plugins';
import { ceilingAt, DEFAULT_CEILING, dropPoint, dropTransform, HOOD_BOTTOM, mountOf } from './place';

const I = inches;

describe('dropping a prop (the place tool)', () => {
  it('rests on a face that looks up (a counter), else on the floor; strips stick under a face that looks down', () => {
    const counter = { point: [I(10), I(36), I(12)] as V3, normal: [0, 1, 0] as V3 };
    const wall = { point: [I(10), I(50), 0] as V3, normal: [0, 0, 1] as V3 };
    const under = { point: [I(10), I(54), I(6)] as V3, normal: [0, -1, 0] as V3 };
    const floor: V3 = [I(10), 0, I(40)];
    expect(dropPoint(counter, floor, 'floor')).toEqual(counter.point);
    expect(dropPoint(wall, floor, 'floor')).toEqual(floor);
    expect(dropPoint(null, floor, 'floor')).toEqual(floor);
    expect(dropPoint(under, floor, 'under')).toEqual(under.point);
    expect(dropPoint(counter, floor, 'under')).toEqual(floor);
    // Pendants hang over whatever is under the cursor.
    expect(dropPoint(wall, floor, 'ceiling')).toEqual(wall.point);
  });

  it('centers it on the point, front to the camera, sitting on the surface', () => {
    const size: V3 = [I(15), I(24), I(16)];
    const front = dropTransform(size, [I(20), I(36), I(30)], [0, 0.3, 1], 'floor', DEFAULT_CEILING);
    expect(front.transform).toEqual({ position: [I(12.5), I(36), I(22)], rotation: [0, 0, 0] });
    // The camera off to the right (+X): it turns a quarter, its width now along Z.
    const right = dropTransform(size, [I(20), 0, I(30)], [1, 0.5, 0.2], 'floor', DEFAULT_CEILING);
    expect(right.transform.rotation).toEqual([0, 90, 0]);
    expect(right.box).toEqual({ min: [I(12), 0, I(22.5)], max: [I(28), I(24), I(37.5)] });
    // Where the transform puts it is the box it says.
    const r = applyOps(emptyDoc(), [{ op: 'add', entity: { kind: 'block', id: 'b1', transform: right.transform, size } }]);
    if (!r.ok) throw new Error(r.error);
    expect(worldBoxes(r.doc).get('b1')).toEqual(right.box);
  });

  it('hangs pendants and cans from the room’s ceiling (96" without one), and raises hoods and over-range microwaves', () => {
    expect(mountOf('pendant')).toBe('ceiling');
    expect(mountOf('recessedLight')).toBe('ceiling');
    expect(mountOf('stripLight')).toBe('under');
    expect(mountOf('rangeHood')).toEqual({ raised: HOOD_BOTTOM });
    expect(mountOf('microwave', { mount: 'countertop' })).toBe('floor');
    expect(mountOf('barStool')).toBe('floor');
    const room = applyOps(emptyDoc(), [{ op: 'add', entity: { kind: 'assembly', id: 'room', name: 'Room', generator: { type: 'room', params: { left: 0, right: I(144), back: 0, front: I(120), height: I(108) } } } }]);
    if (!room.ok) throw new Error(room.error);
    expect(ceilingAt(room.doc, I(60), I(60))).toBe(I(108));
    expect(ceilingAt(room.doc, I(200), I(60))).toBe(DEFAULT_CEILING);
    expect(ceilingAt(emptyDoc(), 0, 0)).toBe(DEFAULT_CEILING);
    const pendant = dropTransform([I(12), I(30), I(12)], [I(60), I(36), I(60)], [0, 0, 1], 'ceiling', I(108));
    expect(pendant.box.max[1]).toBe(I(108));
    expect(pendant.box.min[1]).toBe(I(78));
    const hood = dropTransform([I(30), I(34), I(20)], [I(15), 0, I(10)], [0, 0, 1], { raised: HOOD_BOTTOM }, I(96));
    // A tall chimney stays under the ceiling.
    expect(hood.box.min[1]).toBe(I(62));
    const strip = dropTransform([I(24), 24, I(1)], [I(12), I(54), I(6)], [0, 0, 1], 'under', I(96));
    expect(strip.box.max[1]).toBe(I(54));
  });
});

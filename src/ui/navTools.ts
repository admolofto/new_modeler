import * as THREE from 'three';
import type { Doc } from '../model/schema';
import { hiddenNodes } from '../model/visibility';
import { frameNodes } from '../render/frameNodes';
import type { Viewport } from '../render/viewport';
import type { Tool } from './tools';

/**
 * The camera tools, for a left button: Orbit (O), Pan (H) and Zoom (Z), as in SketchUp. The middle
 * button orbits (Shift: pans), the right one pans and the wheel zooms toward the cursor whatever
 * tool is on (render/viewport.ts), so these are for trackpads and habit. Shift+Z fits the model.
 */
export function navTools(viewport: Viewport): Tool[] {
  const { controls } = viewport;
  const tool = (id: 'orbit' | 'pan' | 'zoom', name: string, key: string, icon: Tool['icon'], button: THREE.MOUSE, cursor: string, hint: string): Tool => ({
    id,
    name,
    keys: [key],
    icon,
    hint,
    cursor,
    enter: () => void (controls.mouseButtons.LEFT = button),
    exit: () => void (controls.mouseButtons.LEFT = null),
  });
  return [
    tool('orbit', 'Orbit', 'o', 'orbit', THREE.MOUSE.ROTATE, 'grab', 'Drag to orbit. Shift: pan. (Middle-drag orbits in any tool.)'),
    tool('pan', 'Pan', 'h', 'hand', THREE.MOUSE.PAN, 'grab', 'Drag to pan. (Shift + middle-drag or right-drag pans in any tool.)'),
    tool('zoom', 'Zoom', 'z', 'zoom', THREE.MOUSE.DOLLY, 'zoom-in', 'Drag up and down to zoom. Shift+Z fits the whole model. (The wheel zooms in any tool.)'),
  ];
}

/** Fits everything showing in the view, keeping the viewing direction (SketchUp's Zoom Extents). */
export function zoomExtents(viewport: Viewport, doc: Doc): void {
  const hidden = hiddenNodes(doc);
  frameNodes(viewport, doc, Object.keys(doc.parts).filter((id) => !hidden.has(id)));
}

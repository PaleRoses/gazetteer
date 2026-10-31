import { ring as constants } from './constants';
import type { Frame } from './frame';

const { capacity: ringCapacity, stepSeconds: ringStepSeconds } = constants;

export type Ring = Readonly<{ add: (frame: Frame) => void; size: () => number; points: () => readonly Readonly<{ at: number; lat: number; lon: number; sogKnots: number | null }>[] }>;

/** 24 h of one tracked vessel at one point per minute, in preallocated typed arrays (24 bytes a point, ~34 KiB a ring). The oldest point is overwritten. */
export const createRing = (): Ring => {
  const at = new Uint32Array(ringCapacity);
  const lat = new Float64Array(ringCapacity);
  const lon = new Float64Array(ringCapacity);
  const sog = new Float32Array(ringCapacity).fill(NaN);
  let head = 0;
  let size = 0;
  const lastAt = (): number => size === 0 ? -Infinity : at[(head - 1 + ringCapacity) % ringCapacity]!;
  return {
    add: frame => {
      if (frame.at - lastAt() < ringStepSeconds) return;
      at[head] = frame.at; lat[head] = frame.lat; lon[head] = frame.lon; sog[head] = frame.sogKnots ?? NaN;
      head = (head + 1) % ringCapacity;
      size = Math.min(ringCapacity, size + 1);
    },
    size: () => size,
    points: () => Array.from({ length: size }, (_, index) => {
      const slot = (head - size + index + ringCapacity) % ringCapacity;
      return { at: at[slot]!, lat: lat[slot]!, lon: lon[slot]!, sogKnots: Number.isNaN(sog[slot]!) ? null : sog[slot]! };
    }),
  };
};

import type { Shipment } from '../shared';

type Coordinate = Shipment['coordinates'];

export const project = ([longitude, latitude]: Coordinate): Coordinate => [(longitude + 180) * 1000 / 360, (90 - latitude) * 500 / 180];

/** Break date-line crossings at the map edges instead of drawing across continents. */
export const routePath = (route: Shipment['route']): string => route.map((point, index) => {
  const [x, y] = project(point);
  const previous = route[index - 1];
  if (!previous) return `M${x},${y}`;
  const [previousX, previousY] = project(previous);
  const distance = x - previousX;
  if (Math.abs(distance) <= 500) return `L${x},${y}`;
  const wrappedX = x + (distance > 0 ? -1000 : 1000);
  if (wrappedX === previousX) return `M${x},${previousY} L${x},${y}`;
  const edge = distance > 0 ? 0 : 1000;
  const edgeY = previousY + (y - previousY) * (edge - previousX) / (wrappedX - previousX);
  return `L${edge},${edgeY} M${1000 - edge},${edgeY} L${x},${y}`;
}).join(' ');

import { Show } from 'solid-js';
import type { Shipment } from '../core/types';

const ink = '#0b0b0b';

export const riskColour: Readonly<Record<Shipment['risk'], string>> = { delayed: '#f05a45', watch: '#f5b53d', 'on-track': '#e8e6df' };
export const selectionColour = '#5fe3c0';

export function PixelShip() {
  return <svg class="pixel-ship-glyph" viewBox="0 0 22 11" aria-hidden="true" shape-rendering="crispEdges"><path fill="currentColor" fill-rule="evenodd" d="M3 0h1v2H3zM2 2h4v6H2zM3 3v1h2V3zM7 3h3v2H7zM11 3h3v2h-3zM15 3h3v2h-3zM7 6h3v2H7zM11 6h3v2h-3zM15 6h3v2h-3zM19 6h2v2h-2zM0 8h22v1H0zM1 9h20v1H1zM2 10h17v1H2z"/></svg>;
}

export function PixelCrane() {
  return <svg class="pixel-crane-glyph" viewBox="0 0 24 22" aria-hidden="true" shape-rendering="crispEdges"><path fill="currentColor" d="M6 0h2v3H6zM1 3h23v2H1zM3 5h2v17H3zM10 5h2v17h-2zM5 12h5v1H5zM12 5h3v2h-3zM18 5h1v6h-1zM16 11h5v3h-5zM14 15h4v3h-4zM19 15h4v3h-4zM14 19h4v3h-4zM19 19h4v3h-4z"/></svg>;
}

export function PixelTruck() {
  return <svg class="pixel-truck-glyph" viewBox="0 0 22 11" aria-hidden="true" shape-rendering="crispEdges"><path fill="currentColor" fill-rule="evenodd" d="M0 1h14v7H0zM2 2v5h1V2zM5 2v5h1V2zM8 2v5h1V2zM11 2v5h1V2zM15 3h5v5h-5zM17 4v2h2V4zM20 5h2v3h-2zM0 8h22v1H0zM2 9h3v2H2zM8 9h3v2H8zM17 9h3v2h-3z"/></svg>;
}

export function RiskMark(props: Readonly<{ risk: Shipment['risk'] }>) {
  return <Show when={props.risk !== 'on-track'}><svg class={`risk-mark ${props.risk}`} viewBox="0 0 11 11" aria-hidden="true" shape-rendering="crispEdges"><Show when={props.risk === 'watch'} fallback={<path fill="currentColor" d="M3 0h5v1h2v2h1v5h-1v2H8v1H3v-1H1V8H0V3h1V1h2z"/>}><path fill="currentColor" d="M5 0h1v1h1v2h1v2h1v2h1v2h1v2H0V9h1V7h1V5h1V3h1V1h1z"/></Show><path fill={ink} d={props.risk === 'watch' ? 'M5 4h1v3H5zM5 8h1v1H5z' : 'M5 2h1v5H5zM5 8h1v1H5z'}/></svg></Show>;
}

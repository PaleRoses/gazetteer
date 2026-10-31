import { For } from 'solid-js';
import './map-legend.css';

const layers = [
  { id: 'ships', label: 'Ships', symbol: '▰' },
  { id: 'routes', label: 'Routes', symbol: '┄' },
  { id: 'ports', label: 'Ports', symbol: '■' },
  { id: 'warnings', label: 'Warnings', symbol: '!' },
  { id: 'diversions', label: 'Diversions', symbol: '◇' },
] as const;
export type MapLayer = typeof layers[number]['id'];
export type MapVisibility = Readonly<Record<MapLayer, boolean>>;

export function MapLegend(props: Readonly<{ visible: MapVisibility; onToggle: (layer: MapLayer, visible: boolean) => void }>) {
  return <details class="map-layer-legend" open>
    <summary>Map legend <span aria-hidden="true" class="legend-chevron">⌃</span></summary>
    <fieldset>
      <legend class="sr-only">Visible map layers</legend>
      <For each={layers}>{layer => <label>
        <span class={`legend-symbol legend-${layer.id}`} aria-hidden="true">{layer.symbol}</span>
        <span>{layer.label}</span>
        <input type="checkbox" checked={props.visible[layer.id]} onChange={event => props.onToggle(layer.id, event.currentTarget.checked)} />
      </label>}</For>
    </fieldset>
    <div class="legend-risk-key" aria-label="Risk colors">
      <span><i class="legend-normal" />Low / normal</span>
      <span><i class="legend-watch" />Moderate / elevated</span>
      <span><i class="legend-high" />High / severe</span>
    </div>
  </details>;
}

import type { Dashboard, Shipment } from '../shared';
import { project, routePath } from './map-geometry';

const coastline = new URL('./world-coastline.svg', import.meta.url).href;

export function ShipmentMap({ dashboard, selected, onSelect }: Readonly<{ dashboard: Dashboard | null; selected: Shipment | undefined; onSelect: (id: string) => void }>) {
  return <div className="map-canvas">
    <svg className="world-map" viewBox="0 30 1000 420" role="group" aria-label="Shipment map. Select a vessel using the markers or shipment list.">
      <defs><pattern id="map-grid" width="55.55" height="55" patternUnits="userSpaceOnUse"><path d="M55.55 0H0V55" fill="none" stroke="#a5baba" strokeWidth=".5" opacity=".28" /></pattern></defs>
      <rect width="1000" height="520" fill="url(#map-grid)" />
      <image href={coastline} width="1000" height="500" aria-hidden="true" />
      <g className="ocean-labels"><text x="296" y="232">ATLANTIC OCEAN</text><text x="64" y="315">PACIFIC OCEAN</text><text x="554" y="308">INDIAN OCEAN</text><text x="837" y="237">PACIFIC OCEAN</text></g>
      {dashboard?.shipments.filter(shipment => shipment.id !== selected?.id).map(shipment => <path key={shipment.id} d={routePath(shipment.route)} fill="none" stroke="#7c9ab3" strokeWidth="1.2" strokeDasharray="4 6" opacity=".5" />)}
      {selected && <><path d={routePath(selected.route)} fill="none" stroke="white" strokeWidth="5" strokeLinejoin="round" opacity=".7" /><path d={routePath(selected.route)} fill="none" stroke="#245b98" strokeWidth="2.5" strokeLinejoin="round" strokeDasharray="7 5" /></>}
      {dashboard?.ports.map(port => { const [x, y] = project(port.coordinates); return <g key={port.id} transform={`translate(${x},${y})`}><circle r="3" fill="#335b78" stroke="#faf9f2" strokeWidth="2" /><text className="port-label" x="7" y="-8">{port.name}</text></g>; })}
      {dashboard?.shipments.map(shipment => { const [x, y] = project(shipment.coordinates); const active = shipment.id === selected?.id; return <g key={shipment.id} transform={`translate(${x},${y})`} className={`ship-marker ${shipment.risk}${active ? ' selected' : ''}`} role="button" tabIndex={0} aria-label={`${shipment.vessel}, ${shipment.risk.replace('-', ' ')}`} aria-pressed={active} onClick={() => onSelect(shipment.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(shipment.id); } }}>
        {active && <circle className="marker-halo" r="25" />}
        <circle className="marker-disc" r="13" /><path d="M-5 0H5L3.5 5H-3.5ZM-3-1V-5H2V-1M0-5V-7" fill="none" stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
        {shipment.risk !== 'on-track' && <g transform="translate(11,-11)"><circle r="7" fill="#fffaf2" /><text className="marker-alert" textAnchor="middle" y="4">!</text></g>}
        {active && <g transform="translate(0,31)"><rect x="-61" y="-12" rx="5" width="122" height="23" fill="#102a45" /><text className="vessel-label" textAnchor="middle" y="3">{shipment.vessel}</text></g>}
      </g>; })}
    </svg>
    <div className="map-coordinate">NATURAL EARTH <span>·</span> ILLUSTRATIVE ROUTES</div>
    <div className="map-legend"><span><i className="legend-dot on-track" />On schedule</span><span><i className="legend-dot watch" />Watch</span><span><i className="legend-dot delayed" />Delayed</span></div>
  </div>;
}

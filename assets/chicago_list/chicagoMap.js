document.addEventListener('DOMContentLoaded', () => {
    const CHICAGO_CENTER = [41.8781, -87.6298];
    const map = L.map('map', { zoomControl: false }).setView(CHICAGO_CENTER, 11);
    let userLocationMarker = null;

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    // Custom zoom control
    const ZoomControl = L.Control.extend({
        options: { position: 'topright' },
        onAdd() {
            const wrap = L.DomUtil.create('div', 'zoom leaflet-control');
            wrap.innerHTML =
                `<a class="control-button control-button-first" href="#" aria-label="Zoom In" title="Zoom In">
                    <i class="fs-5 bi bi-plus-lg"></i>
                 </a>
                 <a class="control-button control-button-last" href="#" aria-label="Zoom Out" title="Zoom Out">
                    <i class="fs-5 bi bi-dash-lg"></i>
                 </a>`;
            const [inBtn, outBtn] = wrap.querySelectorAll('a');
            L.DomEvent.on(inBtn,  'click', (e) => { L.DomEvent.preventDefault(e); map.zoomIn(); });
            L.DomEvent.on(outBtn, 'click', (e) => { L.DomEvent.preventDefault(e); map.zoomOut(); });
            return wrap;
        }
    });
    new ZoomControl().addTo(map);

    // Custom locate control
    const LocateControl = L.Control.extend({
        options: { position: 'topright' },
        onAdd() {
            const wrap = L.DomUtil.create('div', 'control-locate leaflet-control');
            wrap.innerHTML =
                `<a class="control-button control-button-first control-button-last" href="#" role="button"
                    aria-label="Show My Location" title="Show My Location">
                    <i class="fs-5 bi bi-cursor-fill"></i>
                 </a>`;
            const btn = wrap.querySelector('a');
            L.DomEvent.on(btn, 'click', (e) => {
                L.DomEvent.preventDefault(e);
                if (!navigator.geolocation) {
                    alert('Geolocation is not supported by your browser.');
                    return;
                }
                btn.style.opacity = '0.5';
                navigator.geolocation.getCurrentPosition(
                    (pos) => {
                        const latlng = [pos.coords.latitude, pos.coords.longitude];
                        map.setView(latlng, 16);
                        if (userLocationMarker) map.removeLayer(userLocationMarker);
                        userLocationMarker = L.marker(latlng, {
                            icon: L.divIcon({
                                className: '',
                                html: '<span class="user-location-dot"></span>',
                                iconSize: [14, 14],
                                iconAnchor: [7, 7]
                            })
                        }).bindPopup('You are here').addTo(map);
                        btn.style.opacity = '1';
                    },
                    () => {
                        alert('Unable to retrieve your location.');
                        btn.style.opacity = '1';
                    }
                );
            });
            return wrap;
        }
    });
    new LocateControl().addTo(map);

    // Custom address search control
    let searchMarker = null;
    const SearchControl = L.Control.extend({
        options: { position: 'topright' },
        onAdd() {
            const wrap = L.DomUtil.create('div', 'control-search leaflet-control');
            wrap.innerHTML =
                `<div class="search-collapsed">
                    <a class="control-button control-button-first control-button-last" href="#"
                       role="button" aria-label="Search address" title="Search address">
                       <i class="fs-5 bi bi-search"></i>
                    </a>
                 </div>
                 <div class="search-expanded" style="display:none;">
                     <div class="search-input-row">
                         <input type="text" class="search-input" placeholder="Search address…" aria-label="Address search" />
                         <a class="control-button search-go" href="#" role="button" aria-label="Go">
                             <i class="fs-5 bi bi-search"></i>
                         </a>
                         <a class="control-button search-close control-button-last" href="#" role="button" aria-label="Close search">
                             <i class="fs-5 bi bi-x-lg"></i>
                         </a>
                     </div>
                     <div class="search-status"></div>
                 </div>`;

            const collapsed  = wrap.querySelector('.search-collapsed');
            const expanded   = wrap.querySelector('.search-expanded');
            const input      = wrap.querySelector('.search-input');
            const goBtn      = wrap.querySelector('.search-go');
            const closeBtn   = wrap.querySelector('.search-close');
            const statusDiv  = wrap.querySelector('.search-status');

            // Stop map interactions while typing / clicking inside the control
            L.DomEvent.disableClickPropagation(wrap);
            L.DomEvent.disableScrollPropagation(wrap);

            function openSearch() {
                collapsed.style.display = 'none';
                expanded.style.display  = 'block';
                input.value = '';
                statusDiv.textContent = '';
                input.focus();
            }
            function closeSearch() {
                expanded.style.display  = 'none';
                collapsed.style.display = 'block';
                statusDiv.textContent = '';
            }
            function doSearch() {
                const query = input.value.trim();
                if (!query) return;
                statusDiv.textContent = 'Searching…';
                const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
                fetch(url, { headers: { 'Accept-Language': 'en' } })
                    .then(r => r.json())
                    .then(results => {
                        if (!results.length) {
                            statusDiv.textContent = 'No results found.';
                            return;
                        }
                        const { lat, lon, display_name } = results[0];
                        const latlng = [parseFloat(lat), parseFloat(lon)];
                        map.setView(latlng, 16);
                        if (searchMarker) map.removeLayer(searchMarker);
                        searchMarker = L.marker(latlng)
                            .bindPopup(`<b>Search result</b><br>${display_name}`)
                            .addTo(map)
                            .openPopup();
                        statusDiv.textContent = '';
                    })
                    .catch(() => { statusDiv.textContent = 'Search failed.'; });
            }

            L.DomEvent.on(collapsed.querySelector('a'), 'click', (e) => { L.DomEvent.preventDefault(e); openSearch(); });
            L.DomEvent.on(goBtn,    'click', (e) => { L.DomEvent.preventDefault(e); doSearch(); });
            L.DomEvent.on(closeBtn, 'click', (e) => { L.DomEvent.preventDefault(e); closeSearch(); });
            L.DomEvent.on(input, 'keydown', (e) => { if (e.key === 'Enter') doSearch(); });

            return wrap;
        }
    });
    new SearchControl().addTo(map);

    const MARKER_COLOR = '#0088ff';

    function coloredIcon() {
        return L.divIcon({
            className: 'custom-pin',
            html: `<span style="background:${MARKER_COLOR};width:16px;height:16px;display:block;
                border-radius:50% 50% 50% 0;transform:rotate(-45deg);
                border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,0.25);"></span>`,
            iconSize: [18, 18],
            iconAnchor: [9, 18],
            popupAnchor: [0, -16]
        });
    }

    function escapeHtml(s) {
        return (s || '').replace(/[&<>"']/g, c => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }

    function popupHtml(props) {
        const name = escapeHtml(props.name) || 'Unnamed place';
        // Type and neighborhood only exist when the data came from the sheet.
        const tags = [props.type, props.neighborhood].filter(Boolean).map(escapeHtml).join(' · ');
        const meta = tags ? `<div class="popup-meta">${tags}</div>` : '';
        const addr = props.address ? `<div class="popup-meta">${escapeHtml(props.address)}</div>` : '';
        const desc = props.reviews ? `<br><div class="popup-meta"><i>${escapeHtml(props.reviews)}</i></div>` : '';
        return `<div class="map-popup"><b>${name}</b>${meta}${addr}${desc}</div>`;
    }

    const cluster = L.markerClusterGroup({ chunkedLoading: true });
    cluster.addTo(map);

    let allMarkers = [];   // [{ type, marker }] — rebuilt on each load
    const activeTypes = new Set();
    // False when there are no Type chips at all (the GeoJSON fallback carries no types),
    // which is a different state from "chips exist and every one is unchecked".
    let typeFilter = false;
    const toggleWrap = document.getElementById('layer-toggles');
    const typeWrap = document.getElementById('type-toggles');
    const status = document.getElementById('map-status');

    // The sheet is the source of truth; chicagoData.js falls back to the committed
    // GeoJSON on its own, so anything that reaches .catch here is a real failure.
    window.ChicagoData.load()
        .then(({ features, meta }) => {
            const bounds = [];

            features.forEach(f => {
                const c = f.geometry && f.geometry.coordinates;
                if (!c) return;   // waiting on coordinates — reported in the status line
                const latlng = [c[1], c[0]];
                bounds.push(latlng);
                allMarkers.push({
                    type: (f.properties || {}).type || '',
                    marker: L.marker(latlng, { icon: coloredIcon() })
                        .bindPopup(popupHtml(f.properties || {}))
                });
            });

            // Build the single layer toggle
            if (toggleWrap) {
                const label = document.createElement('label');
                label.className = 'layer-toggle';
                label.setAttribute('for', 'toggle-all');
                label.innerHTML =
                    `<input type="checkbox" id="toggle-all" checked>
                     <span class="layer-swatch" style="background:${MARKER_COLOR}"></span>
                     <span>All</span>
                     <span class="layer-count">(${features.length})</span>`;
                toggleWrap.appendChild(label);
                label.querySelector('input').addEventListener('change', refresh);
            }

            buildTypeToggles(meta.types);
            refresh();

            if (bounds.length) map.fitBounds(bounds, { padding: [30, 30] });
            status.innerHTML = statusHtml(meta);
        })
        .catch(err => {
            status.textContent = 'Could not load map data: ' + err.message;
            status.style.color = '#e31a1c';
        });

    /* A second row of chips filtering by the sheet's Type column. "All types" clears
       the filter; unchecking any single type clears "All types", and re-checking the
       last one turns it back on. */
    function buildTypeToggles(types) {
        const names = Object.keys(types).sort((a, b) => types[b] - types[a] || a.localeCompare(b));
        if (!typeWrap || names.length < 2) return;   // nothing to filter on
        names.forEach(name => activeTypes.add(name));
        typeFilter = true;

        typeWrap.appendChild(typeChip('all-types', 'All types', null, true));
        names.forEach(name => typeWrap.appendChild(typeChip(
            'type-' + name.replace(/\s+/g, '-').toLowerCase(), name, types[name], true)));

        typeWrap.addEventListener('change', e => {
            const input = e.target;
            if (input.id === 'toggle-all-types') {
                // Checking "All types" re-selects everything; unchecking it is a no-op.
                if (!input.checked) { input.checked = true; return; }
                activeTypes.clear();
                names.forEach(name => activeTypes.add(name));
                typeWrap.querySelectorAll('input').forEach(box => { box.checked = true; });
            } else {
                const name = input.getAttribute('data-type');
                if (input.checked) activeTypes.add(name);
                else activeTypes.delete(name);
                const allBox = document.getElementById('toggle-all-types');
                if (allBox) allBox.checked = activeTypes.size === names.length;
            }
            refresh();
        });
    }

    function typeChip(id, label, count, checked) {
        const el = document.createElement('label');
        el.className = 'layer-toggle type-toggle';
        el.setAttribute('for', 'toggle-' + id);
        el.innerHTML =
            `<input type="checkbox" id="toggle-${id}" data-type="${escapeHtml(label)}" ${checked ? 'checked' : ''}>
             <span>${escapeHtml(label)}</span>` +
            (count == null ? '' : `<span class="layer-count">(${count})</span>`);
        return el;
    }

    /* Rebuild the cluster from the current type filter and the master toggle. */
    function refresh() {
        const masterOn = document.getElementById('toggle-all');
        const on = !masterOn || masterOn.checked;
        cluster.clearLayers();
        if (!on) { map.removeLayer(cluster); return; }
        const visible = allMarkers
            .filter(entry => !typeFilter || !entry.type || activeTypes.has(entry.type))
            .map(entry => entry.marker);
        cluster.addLayers(visible);
        if (!map.hasLayer(cluster)) map.addLayer(cluster);
    }

    // Say where the data came from and whether anything is still missing a pin.
    function statusHtml(meta) {
        const source = meta.source === 'sheet'
            ? 'live from the Google Sheet'
            : 'from the committed snapshot (the sheet was unreachable)';
        let text = `${meta.rows} places loaded, ${source}.`;
        if (meta.unplaced && meta.unplaced.length) {
            text += ` ${meta.unplaced.length} await coordinates — run the sheet's ` +
                '"Geocode missing rows" script; they are searchable in the chat meanwhile.';
        }
        return escapeHtml(text).replace(/"|"/g, '"');
    }
});

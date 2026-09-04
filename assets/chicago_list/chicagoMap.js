document.addEventListener('DOMContentLoaded', () => {
    const CHICAGO_CENTER = [41.8781, -87.6298];
    const map = L.map('map', { zoomControl: false }).setView(CHICAGO_CENTER, 11);
    let userLocationMarker = null;

    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
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

    // Icon and color for each place type
    const TYPE_META = {
        'Restaurant':  { icon: 'bi-egg-fried',       color: '#e67e22' },
        'Bar':         { icon: 'bi-cup-straw',        color: '#9b59b6' },
        'Brunch':      { icon: 'bi-cup-hot-fill',     color: '#e91e8c' },
        'Cafe':        { icon: 'bi-cup-hot',          color: '#795548' },
        'Club':        { icon: 'bi-music-note-beamed',color: '#3f51b5' },
        'Sports bar':  { icon: 'bi-trophy-fill',      color: '#1abc9c' },
        'Park':        { icon: 'bi-tree-fill',        color: '#27ae60' },
        'Beach':       { icon: 'bi-water',            color: '#00bcd4' },
        'Museum':      { icon: 'bi-bank2',            color: '#607d8b' },
        'Landmark':    { icon: 'bi-geo-alt-fill',     color: '#e74c3c' },
        'Activity':    { icon: 'bi-bicycle',          color: '#ff9800' },
        'Market':      { icon: 'bi-bag-fill',         color: '#009688' },
        'Retail':      { icon: 'bi-shop-window',      color: '#8bc34a' },
        'Books':       { icon: 'bi-book-fill',        color: '#5c6bc0' },
        'Snack':       { icon: 'bi-cookie',           color: '#ff7043' },
        'Caribbean':   { icon: 'bi-sun-fill',         color: '#ffc107' },
    };
    const DEFAULT_META = { icon: 'bi-pin-map-fill', color: '#0088ff' };

    function typeMeta(type) {
        return TYPE_META[type] || DEFAULT_META;
    }

    function coloredIcon(type) {
        const { icon, color } = typeMeta(type);
        return L.divIcon({
            className: 'custom-pin',
            html: `<span class="map-pin-wrap" style="background:${color}">` +
                  `<i class="bi ${icon} map-pin-icon"></i></span>`,
            iconSize: [28, 28],
            iconAnchor: [14, 28],
            popupAnchor: [0, -28]
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
                const type = (f.properties || {}).type || '';
                allMarkers.push({
                    type,
                    marker: L.marker(latlng, { icon: coloredIcon(type) })
                        .bindPopup(popupHtml(f.properties || {}))
                });
            });

            buildTypeToggles(meta.types, features.length);
            refresh();

            if (bounds.length) map.fitBounds(bounds, { padding: [30, 30] });
            status.innerHTML = statusHtml(meta);
        })
        .catch(err => {
            status.textContent = 'Could not load map data: ' + err.message;
            status.style.color = '#e31a1c';
        });

    /* Single filter bar: "All" chip + one chip per type. Clicking a chip that is already
       the only active one has no effect; clicking "All" resets everything. */
    function buildTypeToggles(types, totalCount) {
        const names = Object.keys(types).sort((a, b) => types[b] - types[a] || a.localeCompare(b));
        if (!typeWrap || names.length < 2) return;   // nothing to filter on
        names.forEach(name => activeTypes.add(name));
        typeFilter = true;

        typeWrap.appendChild(typeChip('all-types', 'All', null, true, true));
        names.forEach(name => typeWrap.appendChild(typeChip(
            'type-' + name.replace(/\s+/g, '-').toLowerCase(), name, types[name], true, false)));

        typeWrap.addEventListener('change', e => {
            const input = e.target;
            if (input.id === 'toggle-all-types') {
                if (!input.checked) { input.checked = true; return; }
                activeTypes.clear();
                names.forEach(name => activeTypes.add(name));
                typeWrap.querySelectorAll('input').forEach(box => { box.checked = true; });
                typeWrap.querySelectorAll('.type-chip').forEach(chip => chip.classList.add('active'));
            } else {
                const name = input.getAttribute('data-type');
                if (input.checked) activeTypes.add(name);
                else activeTypes.delete(name);
                input.closest('.type-chip').classList.toggle('active', input.checked);
                const allOn = activeTypes.size === names.length;
                const allInput = document.getElementById('toggle-all-types');
                const allChip  = allInput && allInput.closest('.type-chip');
                if (allInput) allInput.checked = allOn;
                if (allChip)  allChip.classList.toggle('active', allOn);
            }
            refresh();
        });
    }

    function typeChip(id, label, count, checked, isAll) {
        const { icon, color } = isAll ? DEFAULT_META : typeMeta(label);
        const el = document.createElement('label');
        el.className = 'type-chip' + (checked ? ' active' : '');
        el.setAttribute('for', 'toggle-' + id);
        const countHtml = count != null ? `<span class="chip-count">${count}</span>` : '';
        el.innerHTML =
            `<input type="checkbox" id="toggle-${id}" data-type="${escapeHtml(label)}" ${checked ? 'checked' : ''}>` +
            `<i class="bi ${icon} chip-icon" style="color:${isAll ? '#555' : color}"></i>` +
            `<span class="chip-label">${escapeHtml(label)}</span>` +
            countHtml;
        return el;
    }

    /* Rebuild the cluster from the current type filter. */
    function refresh() {
        cluster.clearLayers();
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

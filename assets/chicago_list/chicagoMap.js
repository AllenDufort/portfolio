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

    // Each layer gets a distinct color.
    const LAYER_COLORS = {
        'Chicago Todo List': '#a0b',
        'Food Spots': 'red',
        'Activities': 'green'
    };
    const DEFAULT_COLOR = '#aa11ff';

    function coloredIcon(color) {
        return L.divIcon({
            className: 'custom-pin',
            html: `<span style="background:${color};width:16px;height:16px;display:block;
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
        const addr = props.address ? `<div class="popup-meta">${escapeHtml(props.address)}</div>` : '';
        const desc = props.reviews ? `<br><div class="popup-meta"><i>${escapeHtml(props.reviews)}</i></div>` : '';
        return `<div class="map-popup"><b>${name}</b>${addr}${desc}</div>`;
    }

    const layerGroups = {};   // name -> markerClusterGroup
    const toggleWrap = document.getElementById('layer-toggles');
    const status = document.getElementById('map-status');

    fetch('assets/chicago_list/chicago_layers.geojson')
        .then(r => {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        })
        .then(data => {
            const bounds = [];
            let total = 0;

            Object.keys(data).forEach(layerName => {
                const color = LAYER_COLORS[layerName] || DEFAULT_COLOR;
                const cluster = L.markerClusterGroup({ chunkedLoading: true });
                const features = (data[layerName] && data[layerName].features) || [];

                features.forEach(f => {
                    const c = f.geometry && f.geometry.coordinates;
                    if (!c) return;
                    const latlng = [c[1], c[0]];
                    bounds.push(latlng);
                    L.marker(latlng, { icon: coloredIcon(color) })
                        .bindPopup(popupHtml(f.properties || {}))
                        .addTo(cluster);
                });

                layerGroups[layerName] = cluster;
                if (layerName === 'Chicago Todo List') cluster.addTo(map);

                if (layerName == 'Chicago Todo List') {
                    total += features.length;
                }

                // Build toggle control
                const id = 'toggle-' + layerName.replace(/\s+/g, '-').toLowerCase();
                const label = document.createElement('label');
                label.className = 'layer-toggle';
                label.setAttribute('for', id);
                const isDefault = layerName === 'Chicago Todo List';
                label.innerHTML =
                    `<input type="checkbox" id="${id}" ${isDefault ? 'checked' : ''}>
                     <span class="layer-swatch" style="background:${color}"></span>
                     <span>${isDefault ? 'All' : escapeHtml(layerName)}</span>
                     <span class="layer-count">(${features.length})</span>`;
                toggleWrap.appendChild(label);

                label.querySelector('input').addEventListener('change', (e) => {
                    if (e.target.checked) {
                        map.addLayer(cluster);
                        // If "Chicago Todo List" was just turned on, uncheck all others
                        if (layerName === 'Chicago Todo List') {
                            Object.keys(layerGroups).forEach(name => {
                                if (name !== 'Chicago Todo List') {
                                    map.removeLayer(layerGroups[name]);
                                    const otherId = 'toggle-' + name.replace(/\s+/g, '-').toLowerCase();
                                    const otherInput = document.getElementById(otherId);
                                    if (otherInput) otherInput.checked = false;
                                }
                            });
                        } else {
                            // If any other toggle is turned on, uncheck "Chicago Todo List"
                            const todoId = 'toggle-chicago-todo-list';
                            const todoInput = document.getElementById(todoId);
                            if (todoInput && todoInput.checked) {
                                todoInput.checked = false;
                                map.removeLayer(layerGroups['Chicago Todo List']);
                            }
                        }
                    } else {
                        map.removeLayer(cluster);
                    }
                });
            });

            if (bounds.length) {
                map.fitBounds(bounds, { padding: [30, 30] });
            }
            status.textContent = `${total} places loaded across ${Object.keys(data).length} layers.`;
        })
        .catch(err => {
            status.textContent = 'Could not load map data: ' + err.message;
            status.style.color = '#e31a1c';
        });
});

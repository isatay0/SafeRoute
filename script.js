// --- FIREBASE CONFIGURATION ---
// Replace this with your actual config from Firebase Console -> Project Settings
const firebaseConfig = {
  apiKey: "AIzaSyAyK5yga38WSVshQ3_BYU7Jhw6_NUSuD_I",
  authDomain: "saferoute-e947f.firebaseapp.com",
  databaseURL: "https://saferoute-e947f-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "saferoute-e947f",
  storageBucket: "saferoute-e947f.firebasestorage.app",
  messagingSenderId: "80913663200",
  appId: "1:80913663200:web:cb04a1fcbd17741ebb7c85",
  measurementId: "G-PYCD9RD7M1"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// --- MAP & LOGIC VARIABLES ---
const SHYMKENT = [42.3155, 69.5869];
let INCIDENT_RADIUS = 0.2;

const map = L.map('map').setView(SHYMKENT, 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);

let mode = "route", startPoint = null, endPoint = null;
let startMarker = null, endMarker = null, fastLayer = null, safeLayer = null;
let incidents = []; // Now managed by Firebase
let incidentMarkers = [];
let debounceTimer;

const slider = document.getElementById("riskWeight");
const sliderValue = document.getElementById("riskValue");

slider.oninput = () => {
    sliderValue.innerText = slider.value + "%";
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { if (startPoint && endPoint) buildRoutes(); }, 500);
};

function setMode(m) { mode = m; }

// --- CLOUD DATA SYNC ---

// Listen for changes from all users
db.ref('incidents').on('value', (snapshot) => {
    const data = snapshot.val();
    // Firebase returns an object; we need an array for our logic
    incidents = [];
    if (data) {
        Object.keys(data).forEach(key => {
            incidents.push({ id: key, ...data[key] });
        });
    }
    renderIncidentsOnMap();
    if (startPoint && endPoint) buildRoutes();
});

// Delete from Firebase
window.deleteIncident = function(firebaseId) {
    db.ref(`incidents/${firebaseId}`).remove();
};

map.on("click", e => {
    if (mode === "incident") {
        const desc = prompt("Event description:", "Danger zone");
        const r = prompt("Risk Level (1-10):", "10");
        if (desc && r) {
            const newIncident = { 
                lat: e.latlng.lat, 
                lng: e.latlng.lng, 
                risk: parseInt(r), 
                desc: desc 
            };
            db.ref('incidents').push(newIncident); // Push to cloud
        }
    } else { handlePoints(e.latlng); }
});

// --- ROUTING LOGIC (Unchanged from original) ---

function handlePoints(latlng) {
    if (!startPoint) {
        startPoint = latlng;
        startMarker = L.circleMarker(latlng, {color: '#0d47a1', radius: 8, fillOpacity: 0.8}).addTo(map);
    } else if (!endPoint) {
        endPoint = latlng;
        endMarker = L.circleMarker(latlng, {color: '#2e7d32', radius: 8, fillOpacity: 0.8}).addTo(map);
        buildRoutes();
    } else {
        resetRoute();
        handlePoints(latlng);
    }
}

async function buildRoutes() {
    if (!startPoint || !endPoint) return;
    const stats = document.getElementById("stats");
    stats.innerHTML = "<i>Checking for safety...</i>";

    const profile = document.getElementById("travelMode").value;
    const priority = parseInt(slider.value);
    const isAbsolute = (priority === 100);

    const fast = await fetchRoute([startPoint, endPoint], profile);
    if (!fast) return;

    let finalRoute = fast;
    let collisions = findCollisions(fast);

    if (collisions.length > 0 && priority > 0) {
        const safeDetour = await findSafeAlternative(fast, collisions, profile, isAbsolute);
        
        if (safeDetour) {
            const detourCollisions = findCollisions(safeDetour);
            
            if (isAbsolute && detourCollisions.length > 0) {
                finalRoute = fast; 
            } else {
                const penalty = isAbsolute ? 1e20 : Math.pow(priority, 5);
                const fastScore = fast.dist + (calculateTotalRisk(fast) * penalty);
                const detourScore = safeDetour.dist + (calculateTotalRisk(safeDetour) * penalty);
                if (detourScore < fastScore) finalRoute = safeDetour;
            }
        }
    }
    render(fast, finalRoute, isAbsolute);
}

async function findSafeAlternative(base, collisions, profile, isAbsolute) {
    const bearing = turf.bearing(turf.point([startPoint.lng, startPoint.lat]), turf.point([endPoint.lng, endPoint.lat]));
    const offsets = isAbsolute ? [0.5, 0.8, 1.2] : [0.4, 0.7];
    let bestCandidate = null;

    for (let dist of offsets) {
        for (let side of [-1, 1]) {
            const waypoints = collisions.map(inc => {
                const pt = turf.point([inc.lng, inc.lat]);
                const dPt = turf.destination(pt, dist, bearing + (90 * side), {units: 'kilometers'});
                return L.latLng(dPt.geometry.coordinates[1], dPt.geometry.coordinates[0]);
            });

            const candidate = await fetchRoute([startPoint, ...waypoints, endPoint], profile);
            if (candidate) {
                const cHits = findCollisions(candidate);
                if (cHits.length === 0) return candidate;
                if (!bestCandidate || calculateTotalRisk(candidate) < calculateTotalRisk(bestCandidate)) {
                    bestCandidate = candidate;
                }
            }
        }
    }
    return bestCandidate;
}

function findCollisions(route) {
    const line = turf.lineString(route.poly);
    return incidents.filter(inc => {
        const dist = turf.pointToLineDistance(turf.point([inc.lng, inc.lat]), line, {units: 'kilometers'});
        const margin = (parseInt(slider.value) === 100) ? 0.01 : 0;
        return dist < (INCIDENT_RADIUS + margin);
    });
}

async function fetchRoute(pts, profile) {
    const coords = pts.map(p => `${p.lng},${p.lat}`).join(';');
    try {
        const r = await fetch(`https://router.project-osrm.org/route/v1/${profile}/${coords}?overview=full&geometries=geojson`);
        const d = await r.json();
        return (d.routes && d.routes.length > 0) ? { poly: d.routes[0].geometry.coordinates, dist: d.routes[0].distance } : null;
    } catch { return null; }
}

function calculateTotalRisk(route) {
    return findCollisions(route).reduce((sum, inc) => sum + inc.risk, 0);
}

function render(fast, safe, isAbsolute) {
    if (fastLayer) map.removeLayer(fastLayer);
    if (safeLayer) map.removeLayer(safeLayer);

    const collisions = findCollisions(safe);
    const danger = collisions.length > 0;

    fastLayer = L.geoJSON({type:"LineString", coordinates:fast.poly}, {style:{color:"#ccc", weight:3, opacity:0.3}}).addTo(map);
    
    const routeColor = (isAbsolute && danger) ? "#b71c1c" : "#0d47a1"; 
    safeLayer = L.geoJSON({type:"LineString", coordinates:safe.poly}, {style:{color: routeColor, weight:6}}).addTo(map);

    let html = `<b>🏁 Distance: ${(safe.dist/1000).toFixed(2)} km</b><hr>`;
    
    if (isAbsolute && danger) {
        html += `<b style="color:#b71c1c">❌ ABSOLUTE DEADLOCK:<br>No safe path exists!</b>`;
    } else if (danger) {
        html += `<b style="color:orange">⚠️ Total Risk: ${calculateTotalRisk(safe)} (Avoidance limited)</b>`;
    } else {
        html += `<b style="color:green">✅ ROUTE IS SAFE</b>`;
    }
    document.getElementById("stats").innerHTML = html;
}

function renderIncidentsOnMap() {
    incidentMarkers.forEach(m => map.removeLayer(m));
    
    incidentMarkers = incidents.map((inc) => {
        const c = L.circle([inc.lat, inc.lng], {
            radius: INCIDENT_RADIUS*1000, 
            color: '#b71c1c', 
            fillOpacity: 0.2, 
            weight: 1
        }).addTo(map);
        
        const popupContent = `
            <div style="text-align:center; min-width: 120px;">
                <b>${inc.desc}</b><br>
                <span style="color:#b71c1c; font-weight:bold;">Risk Level: ${inc.risk}</span>
                <br>
                <button onclick="window.deleteIncident('${inc.id}')" class="popup-delete-btn">
                    🗑 Delete Zone
                </button>
            </div>
        `;
        
        c.bindPopup(popupContent);
        return c;
    });
}

function resetIncidents() { 
    if(confirm("Delete ALL global data?")) {
        db.ref('incidents').set(null); 
        resetRoute(); 
    }
} 

function resetRoute() {
    [startMarker, endMarker, fastLayer, safeLayer].forEach(x => x && map.removeLayer(x));
    startPoint = endPoint = null;
    document.getElementById("stats").innerText = "Select points on map.";
}

window.addEventListener('resize', function() {
    setTimeout(function(){ map.invalidateSize(); }, 400);
});
setTimeout(function(){ map.invalidateSize(); }, 100);
// Mock firebase/app
vi.mock('firebase/app', () => {
  return {
    initializeApp: vi.fn().mockReturnValue({
      // Mock app properties if needed
    }),
  };
});

// Mock firebase/auth
vi.mock('firebase/auth', () => ({
  getAuth: vi.fn().mockReturnValue({
    currentUser: null,
    onIdTokenChanged: vi.fn(),
  }),
  signInWithEmailAndPassword: vi.fn(),
  signInWithPopup: vi.fn(),
  signOut: vi.fn(),
  onAuthStateChanged: vi.fn(),
  updateProfile: vi.fn(),
}));

// Mock firebase/firestore
vi.mock('firebase/firestore', () => ({
  getFirestore: vi.fn().mockReturnValue({
    // Mock Firestore instance if needed
  }),
  collection: vi.fn().mockImplementation(() => {
    return {};
  }),
  onSnapshot: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
  orderBy: vi.fn(),
  doc: vi.fn(),
  updateDoc: vi.fn(),
  setDoc: vi.fn(),
  deleteDoc: vi.fn(),
  addDoc: vi.fn(),
  serverTimestamp: vi.fn(),
  getDocs: vi.fn(),
}));

// Mock ../api/config.js for socket.js and any other modules that use it
vi.mock('../api/config.js', () => ({
  API_CONFIG: {
    SOCKET_URL: 'http://localhost',
    API_URL: 'http://localhost',
    DRIVER_TRACKING_URL: 'http://localhost',
  },
}));

// Mock other dependencies
vi.mock('../api/authService.js');
vi.mock('../api/sapService.js');
vi.mock('../components/MapManager.js');
vi.mock('../components/MapTrackingPanel.js');
vi.mock('../api/firebase.js', () => ({ db: {}, auth: {onAuthStateChanged: () => () => {}} }));
vi.mock('../api/socket.js', () => ({
  socket: { on: vi.fn(), off: vi.fn() },
  EVENTS: { POD_UPDATED: 'pod_updated' },
  getDriverSocket: vi.fn(),
  getProfileSocket: vi.fn(() => ({on: vi.fn()})),
  connectDriverSocket: vi.fn(),
}));

describe('R48 elapsed timestamp display', () => {
  test('missing and invalid role-request timestamps do not crash the dashboard', async () => {
    const {Dashboard} = await import('./dashboard.js');
    const dashboard = Object.create(Dashboard.prototype);
    expect(dashboard._formatElapsed(null)).toBe('just now');
    expect(dashboard._formatElapsed(new Date('invalid'))).toBe('just now');
  });
  test('Firestore timestamps display the same elapsed time as Date values', async () => {
    const {Dashboard} = await import('./dashboard.js');
    const dashboard = Object.create(Dashboard.prototype);
    const date = new Date(Date.now() - 65 * 60000);
    expect(dashboard._formatElapsed({toDate: () => date})).toBe(dashboard._formatElapsed(date));
  });
});

describe('Dashboard startup dependencies', () => {
  test('starts authentication without a global Leaflet script', async () => {
    const {Dashboard} = await import('./dashboard.js');
    const {AuthService} = await import('../api/authService.js');
    const dashboard = Object.create(Dashboard.prototype);
    dashboard.config = {};
    dashboard._setupEventListeners = vi.fn();
    dashboard._listenToRoleRequests = vi.fn();
    dashboard._initMap = vi.fn();
    const originalLeaflet = globalThis.L;
    delete globalThis.L;
    try {
      await dashboard.init();
      expect(AuthService.subscribe).toHaveBeenCalled();
      expect(dashboard._setupEventListeners).toHaveBeenCalled();
    } finally {
      if (originalLeaflet === undefined) delete globalThis.L;
      else globalThis.L = originalLeaflet;
    }
  });

  test('replaces an unresponsive authentication splash with secure recovery actions', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="gatekeeper"><p id="loaderStatus">Loading</p></div>';
    const {Dashboard} = await import('./dashboard.js');
    const dashboard = Object.create(Dashboard.prototype);
    dashboard.config = {gatekeeperId: 'gatekeeper'};
    dashboard._setupEventListeners = vi.fn();
    dashboard._listenToRoleRequests = vi.fn();
    dashboard._initMap = vi.fn();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await dashboard.init();
      await vi.advanceTimersByTimeAsync(15000);

      const gatekeeper = document.getElementById('gatekeeper');
      expect(gatekeeper.textContent).toContain('Dashboard could not start');
      expect(gatekeeper.querySelector('#retryDashboardStartup')).not.toBeNull();
      expect(gatekeeper.querySelector('#returnToDashboardSignIn')).not.toBeNull();
      expect(gatekeeper.getAttribute('role')).toBe('alert');
      expect(errorLog).toHaveBeenCalledWith('[startup] dashboard startup timed out', {
        stage: 'authentication and profile verification',
      });
    } finally {
      errorLog.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('Orders availability by build environment', () => {
  const renderNavigation = async () => {
    document.body.innerHTML = `
      <nav>
        <button id="rOrders"></button>
        <button id="rOverview"></button>
      </nav>
      <aside id="sidePanel"></aside>
      <div id="mainContent"></div><div id="usersContent"></div>
      <div id="sapContent"></div><div id="fleetContent"></div>
      <div id="ordersContent"></div><div id="trackingContent"></div>
      <div id="docsContent"></div><h1 id="viewTitle"></h1>
      <div id="underDevOverlay" aria-hidden="true">
        <h2 id="underDevTitle"></h2><p id="underDevDescription"></p>
      </div>
    `;
    const {Dashboard} = await import('./dashboard.js');
    const dashboard = Object.create(Dashboard.prototype);
    dashboard.state = {activeView: 'overview'};
    dashboard.renderOrders = vi.fn();
    return dashboard;
  };

  test('shows the polished under-development notice instead of Orders in production', async () => {
    vi.stubEnv('PROD', true);
    const dashboard = await renderNavigation();

    await dashboard.handleNavClick('Orders');

    expect(dashboard.renderOrders).not.toHaveBeenCalled();
    expect(document.getElementById('ordersContent').classList.contains('hidden')).toBe(true);
    expect(document.getElementById('underDevOverlay').style.opacity).toBe('1');
    expect(document.getElementById('underDevOverlay').getAttribute('aria-hidden')).toBe('false');
    expect(document.getElementById('underDevTitle').textContent).toBe('Orders is under development');
    vi.unstubAllEnvs();
  });

  test('keeps Orders available for local development builds', async () => {
    vi.stubEnv('PROD', false);
    const dashboard = await renderNavigation();

    await dashboard.handleNavClick('Orders');

    expect(dashboard.renderOrders).toHaveBeenCalledOnce();
    expect(document.getElementById('ordersContent').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('underDevOverlay').style.opacity).toBe('0');
    vi.unstubAllEnvs();
  });
});

describe('Settings and theme preferences', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button id="themeToggle" aria-label="Toggle dark/light mode"></button>
      <svg id="iconLight"></svg><svg id="iconDark" class="hidden"></svg>
      <button data-theme-choice="dark" aria-pressed="true"></button>
      <button data-theme-choice="light" aria-pressed="false"></button>
      <div id="mainContent"></div><div id="usersContent"></div><div id="sapContent"></div>
      <div id="fleetContent"></div><div id="ordersContent"></div><div id="trackingContent"></div>
      <div id="docsContent"></div><section id="settingsContent" class="hidden"></section>
      <aside id="sidePanel" class="open"></aside><h2 id="viewTitle"></h2>
    `;
    localStorage.clear();
  });

  test('Settings opens as a real view instead of falling back to Overview', async () => {
    const {Dashboard} = await import('./dashboard.js');
    const dashboard = Object.create(Dashboard.prototype);
    dashboard.state = {activeView: 'overview', theme: 'dark'};

    await dashboard.handleNavClick('Settings');

    expect(document.getElementById('settingsContent').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('mainContent').classList.contains('hidden')).toBe(true);
    expect(document.getElementById('viewTitle').textContent).toBe('Settings');
    expect(document.getElementById('sidePanel').classList.contains('open')).toBe(false);
  });

  test('theme choices and the rail toggle stay in sync and persist across reloads', async () => {
    const {Dashboard} = await import('./dashboard.js');
    const dashboard = Object.create(Dashboard.prototype);
    dashboard.state = {theme: 'dark'};
    localStorage.setItem('sysu-theme', 'light');

    dashboard._setupThemeControls();

    const darkChoice = document.querySelector('[data-theme-choice="dark"]');
    const lightChoice = document.querySelector('[data-theme-choice="light"]');
    const toggle = document.getElementById('themeToggle');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(lightChoice.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Switch to dark theme');

    darkChoice.click();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(localStorage.getItem('sysu-theme')).toBe('dark');
    expect(darkChoice.getAttribute('aria-pressed')).toBe('true');

    toggle.click();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('sysu-theme')).toBe('light');
    expect(darkChoice.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('Warehouse Base map tiles', () => {
  test('uses the existing OpenStreetMap provider and displays attribution', async () => {
    document.body.innerHTML = '<div id="warehouseBaseMap"></div>';
    const map = {
      on: vi.fn(),
      invalidateSize: vi.fn(),
      attributionControl: {setPosition: vi.fn(), setPrefix: vi.fn()},
    };
    const marker = { on: vi.fn(), setLatLng: vi.fn() };
    marker.addTo = vi.fn(() => marker);
    const circle = { setLatLng: vi.fn(), setRadius: vi.fn() };
    circle.addTo = vi.fn(() => circle);
    const tileLayer = { addTo: vi.fn(() => map) };
    const leaflet = (await import('leaflet')).default;
    const mapSpy = vi.spyOn(leaflet, 'map').mockReturnValue(map);
    const tileLayerSpy = vi.spyOn(leaflet, 'tileLayer').mockReturnValue(tileLayer);
    const divIconSpy = vi.spyOn(leaflet, 'divIcon').mockReturnValue({});
    const markerSpy = vi.spyOn(leaflet, 'marker').mockReturnValue(marker);
    const circleSpy = vi.spyOn(leaflet, 'circle').mockReturnValue(circle);
    vi.useFakeTimers();

    try {
      const {Dashboard} = await import('./dashboard.js');
      const {constrainMapToPhilippines} = await import('../components/MapManager.js');
      const dashboard = Object.create(Dashboard.prototype);
      dashboard._initWarehouseBaseMap(14.67, 121.01, 100);

      expect(mapSpy).toHaveBeenCalledWith('warehouseBaseMap', expect.objectContaining({
        center: [14.67, 121.01],
        zoomSnap: 0,
        minZoom: 5,
        maxBoundsViscosity: 1,
        maxBounds: expect.anything(),
        attributionControl: true,
      }));
      expect(map.attributionControl.setPosition).toHaveBeenCalledWith('bottomleft');
      expect(map.attributionControl.setPrefix).toHaveBeenCalledWith(false);
      expect(constrainMapToPhilippines).toHaveBeenCalledWith(map);
      expect(tileLayerSpy).toHaveBeenCalledWith(
        'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        expect.objectContaining({
          subdomains: ['a', 'b', 'c'],
          attribution: expect.stringContaining('OpenStreetMap'),
        }),
      );
      expect(tileLayer.addTo).toHaveBeenCalledWith(map);
      expect(marker.addTo).toHaveBeenCalledWith(map);
      expect(circle.addTo).toHaveBeenCalledWith(map);
    } finally {
      vi.useRealTimers();
      mapSpy.mockRestore();
      tileLayerSpy.mockRestore();
      divIconSpy.mockRestore();
      markerSpy.mockRestore();
      circleSpy.mockRestore();
    }
  });
});

describe('User Management deletion state', () => {
  test('hides completed tombstones and identifies retryable account deletions', async () => {
    document.body.innerHTML = '<table><tbody id="userTableBody"></tbody></table>';
    const {Dashboard} = await import('./dashboard.js');
    const dashboard = Object.create(Dashboard.prototype);
    dashboard.state = {
      user: {uid: 'admin-id', role: 'super_admin'},
      _activeUserTab: 'employees',
      _userSearchQuery: '',
    };
    dashboard.deleteUserRecord = vi.fn();

    dashboard._renderUsersTable([
      {id: 'completed-123456', role: 'pending', status: 'disabled', deletionState: 'complete'},
      {id: 'pending-654321', name: 'User', role: 'pending', status: 'disabled', deletionState: 'pending'},
    ]);

    const body = document.getElementById('userTableBody');
    expect(body.textContent).not.toContain('completed-123456');
    expect(body.textContent).toContain('Unnamed account · …654321');
    expect(body.textContent).toContain('Account ID ending 654321');
    expect(body.textContent).toContain('Deletion in progress');
    const retryButton = body.querySelector('[data-action="delete-user"]');
    expect(retryButton.textContent).toBe('Retry Delete');
    retryButton.click();
    expect(dashboard.deleteUserRecord).toHaveBeenCalledWith('pending-654321', 'Unnamed account · …654321');
  });
});

describe('Documents master-record delete visibility', () => {
  test.each(['admin', 'super_admin'])('%s can see Delete for guards and truck companies', async (role) => {
    document.body.innerHTML = '<div id="guardListBody"></div><div id="tcListBody"></div>';
    const {Dashboard} = await import('./dashboard.js');
    const dashboard = Object.create(Dashboard.prototype);
    dashboard.state = {
      user: {role},
      guardsLoading: false,
      guardsLoadError: false,
      _guards: { 'SG-001': {id:'SG-001', guardId:'SG-001', fullName:'Synthetic Guard', active:true} },
      _truckCompanies: { '01': {id:'01', companyCode:'01', name:'Synthetic Company', active:true} },
    };
    dashboard._showToast = vi.fn();

    dashboard._refreshGuardList();
    dashboard._refreshTcList();

    expect(document.querySelector('[data-action="guard-delete"]')).not.toBeNull();
    expect(document.querySelector('[data-action="tc-delete"]')).not.toBeNull();
  });

  test('other roles do not see permanent Delete actions', async () => {
    document.body.innerHTML = '<div id="guardListBody"></div><div id="tcListBody"></div>';
    const {Dashboard} = await import('./dashboard.js');
    const dashboard = Object.create(Dashboard.prototype);
    dashboard.state = {
      user: {role:'fleet_manager'},
      guardsLoading: false,
      guardsLoadError: false,
      _guards: { 'SG-001': {id:'SG-001', guardId:'SG-001', fullName:'Synthetic Guard', active:true} },
      _truckCompanies: { '01': {id:'01', companyCode:'01', name:'Synthetic Company', active:true} },
    };

    dashboard._refreshGuardList();
    dashboard._refreshTcList();

    expect(document.querySelector('[data-action="guard-delete"]')).toBeNull();
    expect(document.querySelector('[data-action="tc-delete"]')).toBeNull();
  });
});

describe('filterSap', () => {
  let dashboard;

  beforeEach(async () => {
    // Reset DOM
    document.body.innerHTML = '';

    // Create the required elements for the sapTab buttons
    const filterDiv = document.createElement('div');
    filterDiv.innerHTML = `
      <button id="sapTabDelivered"></button>
      <button id="sapTabTransit"></button>
      <button id="sapTabFullyLoaded"></button>
      <button id="sapTabLoading"></button>
      <button id="sapTabAssigned"></button>
      <button id="sapTabForAssignment"></button>
    `;
    document.body.appendChild(filterDiv);

    // Exercise the real class without starting live authentication/listeners.
    const { Dashboard } = await import('./dashboard.js');
    dashboard = Object.create(Dashboard.prototype);
    dashboard.state = {};

    // Reset state
    dashboard.state.sapAssignments = {};
    dashboard.state.sapFilter = 'all';
    // Mock _renderSapTable to track calls
    dashboard._renderSapTable = vi.fn();
    dashboard._syncSAP = vi.fn().mockResolvedValue(undefined);
  });

  test('sets filter to delivered and activates correct tab', () => {
    dashboard.filterSap('delivered');
    expect(dashboard.state.sapFilter).toBe('delivered');
    expect(dashboard._renderSapTable).toHaveBeenCalled();
    const activeTab = document.getElementById('sapTabDelivered');
    expect(activeTab.classList.contains('bg-db-item-active')).toBe(true);
    expect(activeTab.classList.contains('text-db-text')).toBe(true);
    expect(activeTab.classList.contains('active')).toBe(true);
    // Ensure other tabs are not active
    const otherTab = document.getElementById('sapTabTransit');
    expect(otherTab.classList.contains('bg-db-item-active')).toBe(false);
  });

  test('sets filter to in_transit and activates correct tab', () => {
    dashboard.filterSap('in_transit');
    expect(dashboard.state.sapFilter).toBe('in_transit');
    expect(dashboard._renderSapTable).toHaveBeenCalled();
    const activeTab = document.getElementById('sapTabTransit');
    expect(activeTab.classList.contains('bg-db-item-active')).toBe(true);
    expect(activeTab.classList.contains('text-db-text')).toBe(true);
    expect(activeTab.classList.contains('active')).toBe(true);
  });

  test('sets filter to fully_loaded and activates correct tab', () => {
    dashboard.filterSap('fully_loaded');
    expect(dashboard.state.sapFilter).toBe('fully_loaded');
    expect(dashboard._renderSapTable).toHaveBeenCalled();
    const activeTab = document.getElementById('sapTabFullyLoaded');
    expect(activeTab.classList.contains('bg-db-item-active')).toBe(true);
    expect(activeTab.classList.contains('text-db-text')).toBe(true);
    expect(activeTab.classList.contains('active')).toBe(true);
  });

  test('sets filter to loading and activates correct tab', () => {
    dashboard.filterSap('loading');
    expect(dashboard.state.sapFilter).toBe('loading');
    expect(dashboard._renderSapTable).toHaveBeenCalled();
    const activeTab = document.getElementById('sapTabLoading');
    expect(activeTab.classList.contains('bg-db-item-active')).toBe(true);
    expect(activeTab.classList.contains('text-db-text')).toBe(true);
    expect(activeTab.classList.contains('active')).toBe(true);
  });

  test('sets filter to assigned and activates correct tab', () => {
    dashboard.filterSap('assigned');
    expect(dashboard.state.sapFilter).toBe('assigned');
    expect(dashboard._renderSapTable).toHaveBeenCalled();
    const activeTab = document.getElementById('sapTabAssigned');
    expect(activeTab.classList.contains('bg-db-item-active')).toBe(true);
    expect(activeTab.classList.contains('text-db-text')).toBe(true);
    expect(activeTab.classList.contains('active')).toBe(true);
  });

  test('sets filter to forAssignment and activates correct tab', () => {
    dashboard.filterSap('forAssignment');
    expect(dashboard.state.sapFilter).toBe('forAssignment');
    expect(dashboard._renderSapTable).toHaveBeenCalled();
    const activeTab = document.getElementById('sapTabForAssignment');
    expect(activeTab.classList.contains('bg-db-item-active')).toBe(true);
    expect(activeTab.classList.contains('text-db-text')).toBe(true);
    expect(activeTab.classList.contains('active')).toBe(true);
  });

  test('calls _renderSapTable when filter changes', () => {
    dashboard.filterSap('delivered');
    expect(dashboard._renderSapTable).toHaveBeenCalledTimes(1);
    dashboard.filterSap('in_transit');
    expect(dashboard._renderSapTable).toHaveBeenCalledTimes(2);
  });

  test('delivered filter sets sapFilter to "delivered" and renders', () => {
    // Populate sapAssignments with mixed tripStatus values to mirror realistic state.
    // (The actual filter dispatch happens in _renderSapTable, which is mocked here,
    // so this test primarily verifies state side-effects and tab activation.)
    dashboard.state.sapAssignments = {
      'DISP-001': { driverName: 'Juan', truckPlate: 'ABC123', tripStatus: 'completed' },
      'DISP-002': { driverName: 'Pedro', truckPlate: 'DEF456', tripStatus: 'in_transit' },
      'DISP-003': { driverName: 'Maria', truckPlate: 'GHI789', tripStatus: null },
    };

    // Activate the delivered filter — this sets state.sapFilter and triggers _renderSapTable.
    dashboard.filterSap('delivered');

    // Assert state was set correctly and render was invoked.
    expect(dashboard.state.sapFilter).toBe('delivered');
    expect(dashboard._renderSapTable).toHaveBeenCalled();

    // Assert the delivered tab became active (verifies tab mapping is 'delivered' → sapTabDelivered).
    const deliveredTab = document.getElementById('sapTabDelivered');
    expect(deliveredTab.classList.contains('active')).toBe(true);
  });

});

describe('SAP navigation default', () => {
  test('opens SAP on For Assignment and leaves other filters selectable', async () => {
    document.body.innerHTML = `
      <div id="sapContent"></div>
      <div id="underDevOverlay" aria-hidden="true"></div>
      <div id="sapFilterSpinner" class="hidden"></div>
      <button id="sapTabAll"></button><button id="sapTabDelivered"></button>
      <button id="sapTabTransit"></button><button id="sapTabFullyLoaded"></button>
      <button id="sapTabLoading"></button><button id="sapTabAssigned"></button>
      <button id="sapTabForAssignment"></button>
    `;
    const {Dashboard} = await import('./dashboard.js');
    const dashboard = Object.create(Dashboard.prototype);
    dashboard.state = {activeView: 'overview'};
    dashboard._syncSAP = vi.fn().mockResolvedValue(undefined);
    dashboard._renderSapTable = vi.fn();

    await dashboard.handleNavClick('SAP');

    expect(dashboard.state.sapFilter).toBe('forAssignment');
    expect(document.getElementById('sapTabForAssignment').classList.contains('active')).toBe(true);
    expect(document.getElementById('sapTabDelivered').classList.contains('active')).toBe(false);
    expect(dashboard._renderSapTable).toHaveBeenCalledOnce();

    dashboard.filterSap('delivered');
    expect(dashboard.state.sapFilter).toBe('delivered');
    expect(document.getElementById('sapTabDelivered').classList.contains('active')).toBe(true);
  });
});

describe('SAP shipment feedback', () => {
  let Dashboard;
  let SAPService;
  let dashboard;

  beforeEach(async () => {
    vi.clearAllMocks();
    document.body.innerHTML = `
      <table><tbody id="sapBody"></tbody></table>
      <span id="sapStatAll"></span><span id="sapStatDel"></span>
      <span id="sapStatTransit"></span><span id="sapResultCount"></span>
      <span id="sapLastUpdate"></span><input id="sapSearch" />
    `;
    ({ Dashboard } = await import('./dashboard.js'));
    ({ SAPService } = await import('../api/sapService.js'));
    dashboard = Object.create(Dashboard.prototype);
    SAPService.state = { lastError: null };
  });

  const shipmentGroups = () => ({
    'DISP-001': [{
      SAPDispatchNumber: 'DISP-001',
      OBDNumber: 'OBD-001',
      TruckType: 'AUV',
      Driver: '',
      PlateNumber: '',
      ShipmentStart: '',
      Delivery: '',
    }],
  });

  test('shows a useful assigned-filter empty state instead of a blank table', () => {
    dashboard.state = {
      sapLoading: false,
      sapLoadError: false,
      sapGroupedByDispatch: shipmentGroups(),
      sapAssignments: {},
      sapFilter: 'assigned',
      sapSortKey: 'SAPDispatchNumber',
      sapSortDir: 1,
    };
    dashboard._loadSapDispatchDetails = vi.fn();

    dashboard._renderSapTable();

    expect(document.querySelector('#sapBody [role="status"]')?.textContent).toBe('No assigned shipments yet.');
    expect(document.getElementById('sapResultCount').textContent).toBe('0 dispatches');
    expect(document.getElementById('sapStatAll').textContent).toBe('1');
  });

  test('keeps the SAP outage warning and retry available when the current filter has no rows', () => {
    dashboard.state = {
      sapLoading: false,
      sapLoadError: true,
      sapGroupedByDispatch: shipmentGroups(),
      sapAssignments: {},
      sapFilter: 'assigned',
      sapSortKey: 'SAPDispatchNumber',
      sapSortDir: 1,
    };
    dashboard._loadSapDispatchDetails = vi.fn();
    dashboard._syncSAP = vi.fn();

    dashboard._renderSapTable();

    expect(document.querySelector('#sapBody [role="alert"]')?.textContent).toContain('Results reflect the last successful sync.');
    expect(document.querySelector('#sapBody [role="status"]')?.textContent).toBe('No assigned shipments yet.');
    document.querySelector('#sapBody [data-action="sap-retry"]').click();
    expect(dashboard._syncSAP).toHaveBeenCalledOnce();
  });

  test('shows a retryable outage message instead of claiming there are no shipments', () => {
    dashboard.state = {
      sapLoading: false,
      sapLoadError: true,
      sapGroupedByDispatch: {},
      sapAssignments: {},
      sapFilter: 'all',
    };
    dashboard._syncSAP = vi.fn();

    dashboard._renderSapTable();

    expect(document.querySelector('#sapBody [role="alert"]')?.textContent).toContain('SAP shipment data is temporarily unavailable.');
    expect(document.querySelector('#sapBody')?.textContent).not.toContain('No shipments available.');
    document.querySelector('[data-action="sap-retry"]').click();
    expect(dashboard._syncSAP).toHaveBeenCalledOnce();
  });

  test('keeps the last successful shipment snapshot after an SAP refresh failure', async () => {
    const lastSuccessfulShipments = [{ SAPDispatchNumber: 'DISP-001' }];
    SAPService.fetchShipments = vi.fn().mockResolvedValue([]);
    SAPService.state.lastError = 'Network unavailable';
    dashboard.state = {
      sapShipments: lastSuccessfulShipments,
      sapLoading: false,
      sapLoadError: false,
    };
    dashboard._rebuildShipmentGroups = vi.fn();
    dashboard._renderAll = vi.fn();
    dashboard._renderSapTable = vi.fn();
    dashboard._updateConnectionBadge = vi.fn();

    await dashboard._syncSAP();

    expect(dashboard.state.sapShipments).toBe(lastSuccessfulShipments);
    expect(dashboard.state.sapLoadError).toBe(true);
    expect(dashboard._renderAll).toHaveBeenCalledOnce();
    expect(dashboard._rebuildShipmentGroups).not.toHaveBeenCalled();
  });

  test('clears the SAP outage state after a successful retry', async () => {
    const shipments = [{ SAPDispatchNumber: 'DISP-002' }];
    SAPService.fetchShipments = vi.fn().mockResolvedValue(shipments);
    SAPService.state.lastError = null;
    dashboard.state = { sapShipments: [], sapLoading: false, sapLoadError: true };
    dashboard._rebuildShipmentGroups = vi.fn();
    dashboard._renderAll = vi.fn();
    dashboard._updateConnectionBadge = vi.fn();

    await dashboard._syncSAP();

    expect(dashboard.state.sapShipments).toBe(shipments);
    expect(dashboard.state.sapLoadError).toBe(false);
    expect(dashboard._renderAll).toHaveBeenCalledOnce();
  });
});

describe('SAP connection help', () => {
  let Dashboard;
  let SAPService;
  let dashboard;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div id="sapConnBadge"><div class="rounded-full"></div><span id="sapConnStatus"></span>
        <button id="sapConnHelpButton" class="hidden" aria-expanded="false"></button>
        <div id="sapConnHelpText" class="hidden">Error connecting to SAP, please check your internet connection.</div>
      </div>`;
    ({Dashboard} = await import('./dashboard.js'));
    ({SAPService} = await import('../api/sapService.js'));
    dashboard = Object.create(Dashboard.prototype);
  });

  test('shows an actionable, toggleable help message only while SAP is disconnected', () => {
    SAPService.state.lastError = 'Network unavailable';
    dashboard._updateConnectionBadge();

    const button = document.getElementById('sapConnHelpButton');
    const helpText = document.getElementById('sapConnHelpText');
    expect(document.getElementById('sapConnStatus').textContent).toBe('Disconnected');
    expect(button.classList.contains('hidden')).toBe(false);
    expect(helpText.classList.contains('hidden')).toBe(true);

    button.addEventListener('click', () => dashboard._toggleSapConnectionHelp());
    button.click();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(helpText.classList.contains('hidden')).toBe(false);
    expect(helpText.textContent).toBe('Error connecting to SAP, please check your internet connection.');

    button.click();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(helpText.classList.contains('hidden')).toBe(true);

    SAPService.state.lastError = null;
    dashboard._updateConnectionBadge();
    expect(document.getElementById('sapConnStatus').textContent).toBe('Connected');
    expect(button.classList.contains('hidden')).toBe(true);
    expect(helpText.classList.contains('hidden')).toBe(true);
  });
});

describe('assignment empty states', () => {
  let Dashboard;
  let dashboard;

  beforeEach(async () => {
    vi.clearAllMocks();
    document.body.innerHTML = `
      <div id="assignDriverModal" class="hidden">
        <span id="assignModalDispatchNum"></span><span id="assignModalTruckType"></span>
        <div id="assignModalDriverList"></div><button id="assignConfirmBtn"></button>
        <div id="requestOverridePanel" class="hidden"></div>
        <select id="requestOverrideReason"></select>
      </div>
    `;
    ({ Dashboard } = await import('./dashboard.js'));
    dashboard = Object.create(Dashboard.prototype);
  });

  test('explains when no queued driver can be assigned to a shipment', () => {
    dashboard.state = {
      queue: [], drivers: [], sapAssignments: {}, queueLoading: false,
      queueLoadError: false, assignmentsLoading: false, assignmentsLoadError: false,
    };
    dashboard._getAvailableDrivers = vi.fn(() => []);
    dashboard._resumeApprovedOverride = vi.fn().mockResolvedValue(undefined);
    dashboard._ensureAdminQueueSubscriptions = vi.fn();

    dashboard.openAssignModal('DISP-001', 'AUV');

    expect(document.querySelector('#assignModalDriverList [role="status"]')?.textContent).toContain('No queued or eligible assigned drivers match the AUV truck type.');
  });

  test('distinguishes a driver availability failure from a genuine no-match result', () => {
    dashboard.state = {
      queue: [], drivers: [], sapAssignments: {}, queueLoading: false,
      queueLoadError: true, assignmentsLoading: false, assignmentsLoadError: false,
    };
    dashboard._getAvailableDrivers = vi.fn(() => []);
    dashboard._resumeApprovedOverride = vi.fn().mockResolvedValue(undefined);
    dashboard._ensureAdminQueueSubscriptions = vi.fn();

    dashboard.openAssignModal('DISP-001', 'AUV');

    expect(document.querySelector('#assignModalDriverList [role="alert"]')?.textContent).toContain('Driver availability could not be loaded.');
    expect(document.querySelector('#assignModalDriverList [role="status"]')).toBeNull();
  });

  test('explains when a fleet driver has no matching unassigned shipment', () => {
    dashboard.state = {
      queue: [{ id: 'driver-1', driverName: 'Test Driver', truckType: 'AUV' }],
      sapGroupedByDispatch: {},
      sapAssignments: {},
      sapLoadError: false,
    };
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});

    dashboard.openAssignModalForDriver('driver-1', 'AUV');

    expect(document.querySelector('#assignModalDriverList [role="status"]')?.textContent).toContain('No unassigned shipments available.');
    expect(alert).not.toHaveBeenCalled();
    alert.mockRestore();
  });
});


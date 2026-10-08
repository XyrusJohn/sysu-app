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
vi.mock('../api/firebase.js', () => ({ db: {}, auth: {} }));
vi.mock('../api/socket.js', () => ({
  socket: { on: vi.fn(), off: vi.fn() },
  EVENTS: { POD_UPDATED: 'pod_updated' },
  getDriverSocket: vi.fn(),
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


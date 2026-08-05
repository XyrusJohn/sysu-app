// Mock firebase/app
jest.mock('firebase/app', () => {
  return {
    initializeApp: jest.fn().mockReturnValue({
      // Mock app properties if needed
    }),
  };
});

// Mock firebase/auth
jest.mock('firebase/auth', () => ({
  getAuth: jest.fn().mockReturnValue({
    currentUser: null,
    onIdTokenChanged: jest.fn(),
  }),
  signInWithEmailAndPassword: jest.fn(),
  signInWithPopup: jest.fn(),
  signOut: jest.fn(),
  onAuthStateChanged: jest.fn(),
  updateProfile: jest.fn(),
}));

// Mock firebase/firestore
jest.mock('firebase/firestore', () => ({
  getFirestore: jest.fn().mockReturnValue({
    // Mock Firestore instance if needed
  }),
  collection: jest.fn().mockImplementation(() => {
    return {};
  }),
  onSnapshot: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
  doc: jest.fn(),
  updateDoc: jest.fn(),
  setDoc: jest.fn(),
  deleteDoc: jest.fn(),
  addDoc: jest.fn(),
  serverTimestamp: jest.fn(),
  getDocs: jest.fn(),
}));

// Mock ../api/config.js for socket.js and any other modules that use it
jest.mock('../api/config.js', () => ({
  API_CONFIG: {
    SOCKET_URL: 'http://localhost',
    API_URL: 'http://localhost',
    DRIVER_TRACKING_URL: 'http://localhost',
  },
}));

// Mock other dependencies
jest.mock('../api/authService.js');
jest.mock('../api/sapService.js');
jest.mock('../components/MapManager.js');
jest.mock('../components/MapTrackingPanel.js');
jest.mock('../api/socket.js');

describe('filterSap', () => {
  let dashboard;

  beforeEach(() => {
    // Reset DOM
    document.body.innerHTML = '';

    // Create the required elements for the sapTab buttons
    const filterDiv = document.createElement('div');
    filterDiv.innerHTML = `
      <button id="sapTabDelivered"></button>
      <button id="sapTabInTransit"></button>
      <button id="sapTabFullyLoaded"></button>
      <button id="sapTabLoading"></button>
      <button id="sapTabAssigned"></button>
      <button id="sapTabForAssignment"></button>
    `;
    document.body.appendChild(filterDiv);

    // Mock global fetch for Firebase
    const fetch = require('whatwg-fetch');
    global.fetch = fetch;
    global.Headers = fetch.Headers;
    global.Request = fetch.Request;
    global.Response = fetch.Response;

    // Load the dashboard module (this will execute the mocked imports)
    require('../pages/dashboard.js');
    // Trigger DOMContentLoaded to instantiate the dashboard
    document.dispatchEvent(new Event('DOMContentLoaded'));
    dashboard = window.dashboard;

    // Reset state
    dashboard.state.sapAssignments = {};
    dashboard.state.sapFilter = 'all';
    // Mock _renderSapTable to track calls
    dashboard._renderSapTable = jest.fn();
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
    const otherTab = document.getElementById('sapTabInTransit');
    expect(otherTab.classList.contains('bg-db-item-active')).toBe(false);
  });

  test('sets filter to in_transit and activates correct tab', () => {
    dashboard.filterSap('in_transit');
    expect(dashboard.state.sapFilter).toBe('in_transit');
    expect(dashboard._renderSapTable).toHaveBeenCalled();
    const activeTab = document.getElementById('sapTabInTransit');
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
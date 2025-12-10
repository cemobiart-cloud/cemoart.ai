
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, Trash2, Tag, Calendar, User, CheckCircle, Edit, ImageIcon, LayoutGrid, MapPin, AlertTriangle, TrendingUp, CalendarClock, Printer } from 'lucide-react';
import { SheetName, NetworkStatus, SyncQueueItem, Product, Sale, Expense, Customer, AppNotification } from './types';
import { STORAGE_KEYS } from './constants';
import { Header } from './components/Header';
import { InputModal } from './components/InputModal';
import { SaleModal } from './components/SaleModal';
import { ConfirmationModal } from './components/ConfirmationModal';
import { ReceiptModal } from './components/ReceiptModal';
import { BottomNav } from './components/BottomNav';
import { getLocalCollection, saveLocalCollection, getSyncQueue, addToSyncQueue, removeFromQueue, updateLocalItem } from './services/storageService';
import { postDataToSheet, fetchRemoteSheetData } from './services/apiService';

// Helper for delays
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper for Date Time formatting (French format: DD/MM/YYYY HH:mm:ss)
const formatDateTime = (date: Date) => {
  return date.toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).replace(',', '');
};

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<SheetName>('Products');
  const [status, setStatus] = useState<NetworkStatus>(navigator.onLine ? NetworkStatus.ONLINE : NetworkStatus.OFFLINE);
  
  // Modal States
  const [isInputModalOpen, setIsInputModalOpen] = useState(false);
  const [isSaleModalOpen, setIsSaleModalOpen] = useState(false);
  const [isReceiptModalOpen, setIsReceiptModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<any>(null); // For InputModal (Edit)
  const [selectedProductForSale, setSelectedProductForSale] = useState<Product | null>(null); // For SaleModal
  const [selectedSaleForReceipt, setSelectedSaleForReceipt] = useState<Sale | null>(null); // For Receipt

  // Delete Confirmation State
  const [deleteConfirmation, setDeleteConfirmation] = useState<{ isOpen: boolean; id: string | null; sheet: SheetName | null }>({
    isOpen: false,
    id: null,
    sheet: null
  });

  const [queueCount, setQueueCount] = useState(0);
  const [showSyncSuccess, setShowSyncSuccess] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  
  // Ref to prevent double firing in React Strict Mode
  const isInitialized = useRef(false);

  // Data State
  const [products, setProducts] = useState<Product[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);

  // --- Notification Logic ---
  const addNotification = (message: string, type: 'error' | 'warning' | 'info' | 'success') => {
    const id = Date.now().toString() + Math.random().toString();
    setNotifications(prev => [...prev, { id, message, type }]);
    
    // Auto dismiss generic info/success messages (but keep warnings/errors)
    if (type === 'info' || type === 'success') {
      setTimeout(() => dismissNotification(id), 4000);
    }
  };

  const dismissNotification = (id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  };

  const checkStockLevels = useCallback((productList: Product[]) => {
    const outOfStockItems = productList.filter(p => p.Stock <= 0);
    const lowStockItems = productList.filter(p => p.Stock > 0 && p.Stock < 10);
    
    // Remove existing stock warnings to avoid duplicates
    setNotifications(prev => prev.filter(n => !n.id.startsWith('stock-')));

    if (outOfStockItems.length > 0) {
      const itemNames = outOfStockItems.map(p => p.Name).slice(0, 3).join('، ');
      const remaining = outOfStockItems.length - 3;
      // Show exact number
      const message = `تنبيه: يوجد ${outOfStockItems.length} منتجات نفذت كميتها: ${itemNames}${remaining > 0 ? ` و ${remaining} أخرى` : ''}`;

      setNotifications(prev => [{
        id: 'stock-out',
        type: 'error',
        message: message
      }, ...prev]);
    } else if (lowStockItems.length > 0) {
      const itemNames = lowStockItems.map(p => p.Name).slice(0, 3).join('، ');
      const remaining = lowStockItems.length - 3;
      // Show exact number
      const message = `تنبيه: يوجد ${lowStockItems.length} منتجات مخزونها منخفض: ${itemNames}${remaining > 0 ? ` و ${remaining} أخرى` : ''}`;

      setNotifications(prev => [{
        id: 'stock-low',
        type: 'warning',
        message: message
      }, ...prev]);
    }
  }, []);

  // Check stock levels whenever products change
  useEffect(() => {
    if (products.length > 0) {
      checkStockLevels(products);
    }
  }, [products, checkStockLevels]);


  // OPTIMIZED SYNC: Accepts optional array of sheets to sync
  const handleSync = useCallback(async (force = false, targetSheets: SheetName[] | null = null) => {
    if (!navigator.onLine) return;
    if (status === NetworkStatus.SYNCING && !force) return;

    console.log("Starting sync process...", targetSheets ? `Targeting: ${targetSheets.join(', ')}` : "Targeting: ALL");
    setStatus(NetworkStatus.SYNCING);
    setShowSyncSuccess(false);
    
    // 1. Process Queue (Upload local changes)
    try {
      const queue = getSyncQueue();
      if (queue.length > 0) {
        for (const item of queue) {
           try {
             await postDataToSheet(item.sheet, item.payload, item.action);
             removeFromQueue(item.id);
             await delay(1000); // Robust delay between writes
           } catch (postError) {
             console.error(`Failed to sync item ${item.id}`, postError);
             addNotification(`فشل مزامنة عنصر (${item.action}) في ${item.sheet}. يرجى المحاولة لاحقاً.`, 'error');
             // We continue loop to try others if possible
           }
        }
        setQueueCount(getSyncQueue().length);
      }
    } catch (error) {
       console.error("Error processing sync queue", error);
       addNotification("حدث خطأ أثناء معالجة طابور المزامنة.", 'error');
    }

    // 2. Fetch Latest Data (Sequentially with delays)
    let hasFetchError = false;

    // Helper to fetch single sheet
    const syncSheet = async (name: SheetName, setFn: Function, key: string) => {
      try {
        await delay(500); // Small initial delay
        console.log(`Fetching ${name}...`);
        const data = await fetchRemoteSheetData(name);
        if (data) {
          setFn(data);
          saveLocalCollection(key, data);
          console.log(`Success: ${name} synced.`);
        }
      } catch (error) {
        console.warn(`Skipping ${name} due to fetch error. Will retry next cycle.`);
        hasFetchError = true;
      }
    };

    // Determine which sheets to sync
    const sheetsToSync = targetSheets || ['Products', 'Sales', 'Expenses', 'Customers'];
    
    const sheetDefinitions: { name: SheetName; setter: Function; key: string }[] = [
      { name: 'Products', setter: setProducts, key: STORAGE_KEYS.PRODUCTS },
      { name: 'Sales', setter: setSales, key: STORAGE_KEYS.SALES },
      { name: 'Expenses', setter: setExpenses, key: STORAGE_KEYS.EXPENSES },
      { name: 'Customers', setter: setCustomers, key: STORAGE_KEYS.CUSTOMERS },
    ];

    // Execute fetches
    for (const def of sheetDefinitions) {
      if (sheetsToSync.includes(def.name)) {
        await syncSheet(def.name, def.setter, def.key);
        // Add robust delay between fetches to prevent rate limiting, only if there are more items
        if (sheetsToSync.length > 1) await delay(1000); 
      }
    }

    if (hasFetchError) {
        addNotification("فشل جلب بعض البيانات من الخادم. تأكد من اتصال الإنترنت.", 'warning');
    }

    console.log("Sync process finished.");
    setStatus(NetworkStatus.ONLINE);
    
    // Show success toast only if no critical errors
    if (!hasFetchError) {
        setShowSyncSuccess(true);
        setTimeout(() => setShowSyncSuccess(false), 3000);
    }
  }, [status]);

  // Load initial data
  useEffect(() => {
    setProducts(getLocalCollection<Product>(STORAGE_KEYS.PRODUCTS));
    setSales(getLocalCollection<Sale>(STORAGE_KEYS.SALES));
    setExpenses(getLocalCollection<Expense>(STORAGE_KEYS.EXPENSES));
    setCustomers(getLocalCollection<Customer>(STORAGE_KEYS.CUSTOMERS));
    setQueueCount(getSyncQueue().length);
    
    // Only sync if online and not already initialized
    if (navigator.onLine && !isInitialized.current) {
      isInitialized.current = true;
      console.log("App initialized. Scheduling initial sync...");
      setTimeout(() => handleSync(), 1500);
    }
  }, [handleSync]);

  // Monitor Network Status
  useEffect(() => {
    const handleOnline = () => {
      setStatus(NetworkStatus.ONLINE);
      console.log("Network Online detected.");
      setTimeout(() => {
          if (!isInitialized.current) {
             handleSync(); 
          }
      }, 3000);
    };
    const handleOffline = () => setStatus(NetworkStatus.OFFLINE);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [handleSync]);

  // --- Actions ---

  const openAddModal = () => {
    setEditingItem(null);
    setIsInputModalOpen(true);
  }

  const openEditModal = (item: any, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent opening sale modal
    setEditingItem(item);
    setIsInputModalOpen(true);
  }

  const openSaleModal = (product: Product) => {
    if (product.Stock <= 0) {
      return; 
    }
    setSelectedProductForSale(product);
    setIsSaleModalOpen(true);
  }

  const openReceiptModal = (sale: Sale, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedSaleForReceipt(sale);
    setIsReceiptModalOpen(true);
  }

  const handleSaveItem = (data: any) => {
    // Determine if Add or Update
    if (editingItem) {
        // UPDATE existing
        // IMPORTANT: Ensure ID is preserved for Sheet mapping and Update ModifiedAt
        let updatedItem = { 
            ...editingItem, 
            ...data,
            ID: editingItem.ID || editingItem.id, // Ensure uppercase ID exists
            ModifiedAt: new Date().toISOString() // Set modification timestamp
        };
        
        // CUSTOMER SPECIFIC: Map Address to Email field for Sheet column mapping
        if (activeTab === 'Customers') {
            updatedItem = {
                ...updatedItem,
                Email: data.Address || updatedItem.Address // Store Address in Email column
            };
        }

        switch (activeTab) {
            case 'Products': setProducts(prev => updateLocalItem(STORAGE_KEYS.PRODUCTS, updatedItem)); break;
            case 'Sales': setSales(prev => updateLocalItem(STORAGE_KEYS.SALES, updatedItem)); break;
            case 'Expenses': setExpenses(prev => updateLocalItem(STORAGE_KEYS.EXPENSES, updatedItem)); break;
            case 'Customers': setCustomers(prev => updateLocalItem(STORAGE_KEYS.CUSTOMERS, updatedItem)); break;
        }

        const queueItem: SyncQueueItem = {
            id: updatedItem.id,
            action: 'UPDATE',
            sheet: activeTab,
            payload: updatedItem,
            timestamp: Date.now()
        };
        addToSyncQueue(queueItem);
        // FIX: Read actual queue length from storage to handle merged actions correctly
        setQueueCount(getSyncQueue().length);

    } else {
        // ADD new
        const id = Date.now().toString();
        let newItem = {
            id: id,
            ID: id, // Explicitly set Uppercase ID for Google Sheet Header mapping
            timestamp: Date.now(),
            ...data
        };

        // CUSTOMER SPECIFIC: Map Address to Email field for Sheet column mapping
        if (activeTab === 'Customers') {
            newItem = {
                ...newItem,
                Email: data.Address, // Store Address in Email column
                LastPurchase: formatDateTime(new Date()) // Set initial date
            };
        }

        switch (activeTab) {
            case 'Products':
                const newProducts = [newItem, ...products];
                setProducts(newProducts);
                saveLocalCollection(STORAGE_KEYS.PRODUCTS, newProducts);
                break;
            case 'Sales':
                const newSales = [newItem, ...sales];
                setSales(newSales);
                saveLocalCollection(STORAGE_KEYS.SALES, newSales);
                break;
            case 'Expenses':
                const newExpenses = [newItem, ...expenses];
                setExpenses(newExpenses);
                saveLocalCollection(STORAGE_KEYS.EXPENSES, newExpenses);
                break;
            case 'Customers':
                const newCustomers = [newItem, ...customers];
                setCustomers(newCustomers);
                saveLocalCollection(STORAGE_KEYS.CUSTOMERS, newCustomers);
                break;
        }

        const queueItem: SyncQueueItem = {
            id: newItem.id,
            action: 'ADD',
            sheet: activeTab,
            payload: newItem,
            timestamp: Date.now()
        };
        addToSyncQueue(queueItem);
        // FIX: Read actual queue length from storage
        setQueueCount(getSyncQueue().length);
    }

    // Trigger sync quickly after save - ONLY for the active sheet
    if (navigator.onLine) {
      setTimeout(() => handleSync(true, [activeTab]), 1000);
    }
  };

  const handleSaleSubmit = (saleData: any, customerData: any) => {
      const timestamp = Date.now();
      const saleId = timestamp.toString();
      const customerId = (timestamp + 1).toString();
      const currentDateTime = formatDateTime(new Date());

      // 1. Create Sale
      const newSale = { 
          id: saleId, 
          ID: saleId, // For Sheet Header
          timestamp, 
          ...saleData,
          Date: currentDateTime // explicitly save Date string in French format
      };
      
      const newSalesList = [newSale, ...sales];
      setSales(newSalesList);
      saveLocalCollection(STORAGE_KEYS.SALES, newSalesList);
      
      addToSyncQueue({
          id: saleId,
          action: 'ADD',
          sheet: 'Sales',
          payload: newSale,
          timestamp
      });

      // 2. Decrement Product Stock
      const productIndex = products.findIndex(p => p.Name === saleData.ProductName);
      if (productIndex !== -1) {
          const productToUpdate = products[productIndex];
          const newStock = Math.max(0, productToUpdate.Stock - saleData.Quantity);
          const updatedProduct = { 
              ...productToUpdate, 
              Stock: newStock,
              ID: productToUpdate.ID || productToUpdate.id, // Ensure ID exists
              ModifiedAt: new Date().toISOString() // Update timestamp
          };
          
          setProducts(prev => updateLocalItem(STORAGE_KEYS.PRODUCTS, updatedProduct));
          
          addToSyncQueue({
              id: updatedProduct.id,
              action: 'UPDATE',
              sheet: 'Products',
              payload: updatedProduct,
              timestamp: timestamp + 2
          });
      }

      // 3. Create/Update Customer
      const existingCustomer = customers.find(c => c.Phone === customerData.Phone);
      
      if (existingCustomer) {
          // Update existing customer total and LastPurchase
          const updatedCustomer = {
              ...existingCustomer,
              TotalPurchases: Number(existingCustomer.TotalPurchases || 0) + Number(saleData.Total),
              Address: customerData.Address || existingCustomer.Address,
              // MAPPING: Address -> Email Column
              Email: customerData.Address || existingCustomer.Address, 
              // UPDATE: Last Purchase Time
              LastPurchase: currentDateTime,
              ID: existingCustomer.ID || existingCustomer.id,
              ModifiedAt: new Date().toISOString()
          };
          updateLocalItem(STORAGE_KEYS.CUSTOMERS, updatedCustomer);
          setCustomers(prev => updateLocalItem(STORAGE_KEYS.CUSTOMERS, updatedCustomer));
          
          addToSyncQueue({
            id: updatedCustomer.id,
            action: 'UPDATE', 
            sheet: 'Customers',
            payload: updatedCustomer,
            timestamp: timestamp + 1
          });

      } else {
          // Create new customer
          const newCustomer = { 
              id: customerId, 
              ID: customerId, // For Sheet Header
              timestamp: timestamp + 1, 
              ...customerData,
              // MAPPING: Address -> Email Column
              Email: customerData.Address,
              // SET: Last Purchase Time
              LastPurchase: currentDateTime
          };
          const newCustomersList = [newCustomer, ...customers];
          setCustomers(newCustomersList);
          saveLocalCollection(STORAGE_KEYS.CUSTOMERS, newCustomersList);

          addToSyncQueue({
            id: customerId,
            action: 'ADD',
            sheet: 'Customers',
            payload: newCustomer,
            timestamp: timestamp + 1
          });
      }

      setQueueCount(getSyncQueue().length);
      
      // Trigger sync quickly after sale - Sync specific affected sheets
      if (navigator.onLine) {
        setTimeout(() => handleSync(true, ['Sales', 'Products', 'Customers']), 1000);
      }
  };

  const openDeleteModal = (id: string, tab: SheetName, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteConfirmation({ isOpen: true, id, sheet: tab });
  };

  const executeDelete = () => {
    const { id, sheet } = deleteConfirmation;
    if (!id || !sheet) return;

    // Helper to add deletion to sync queue
    const queueDelete = (list: any[]) => {
       const itemToDelete = list.find(i => i.id === id);
       if (itemToDelete) {
           addToSyncQueue({
               id: itemToDelete.id,
               action: 'DELETE',
               sheet: sheet,
               payload: { ...itemToDelete, ID: itemToDelete.ID || itemToDelete.id }, // Ensure ID is present for deletion
               timestamp: Date.now()
           });
       }
       return list.filter(i => i.id !== id);
    };

    switch (sheet) {
      case 'Products':
        const p = queueDelete(products);
        setProducts(p);
        saveLocalCollection(STORAGE_KEYS.PRODUCTS, p);
        break;
      case 'Sales':
        const s = queueDelete(sales);
        setSales(s);
        saveLocalCollection(STORAGE_KEYS.SALES, s);
        break;
      case 'Expenses':
        const e = queueDelete(expenses);
        setExpenses(e);
        saveLocalCollection(STORAGE_KEYS.EXPENSES, e);
        break;
      case 'Customers':
        const c = queueDelete(customers);
        setCustomers(c);
        saveLocalCollection(STORAGE_KEYS.CUSTOMERS, c);
        break;
    }
    
    setQueueCount(getSyncQueue().length);
    
    // Trigger sync quickly after delete - Sync only the affected sheet
    if (navigator.onLine) {
        setTimeout(() => handleSync(true, [sheet]), 1000);
    }
  };

  // --- Summary Helpers ---
  const getSalesSummary = () => {
    const now = new Date();
    // Use format DD/MM/YYYY for comparison
    const todayStr = formatDateTime(now).split(' ')[0]; // Gets just DD/MM/YYYY

    const allTimeTotal = sales.reduce((acc, curr) => acc + (Number(curr.Total) || 0), 0);
    
    const todayTotal = sales.reduce((acc, s) => {
        let sDateStr = '';
        
        // 1. Priority: Use locally generated timestamp if available (most accurate for today's data)
        if (s.timestamp) {
            const d = new Date(s.timestamp);
            sDateStr = formatDateTime(d).split(' ')[0];
        } 
        // 2. Fallback: Parse the date string synced from Sheet
        else if (s.Date) {
            // s.Date is expected to be "DD/MM/YYYY HH:mm:ss"
            sDateStr = s.Date.split(' ')[0];
        }

        if (sDateStr === todayStr) {
            return acc + (Number(s.Total) || 0);
        }
        return acc;
    }, 0);

    return { allTimeTotal, todayTotal };
  };

  // --- Render Functions for Lists ---

  const renderProductCard = (item: Product) => {
    const isOutOfStock = item.Stock <= 0;
    const isLowStock = !isOutOfStock && item.Stock < 10;
    
    return (
      <div 
          key={item.id} 
          onClick={() => openSaleModal(item)}
          className={`bg-white rounded-xl shadow-sm border ${
            isOutOfStock ? 'border-gray-200 opacity-60 grayscale cursor-not-allowed' 
            : isLowStock ? 'border-red-300 ring-1 ring-red-100 cursor-pointer active:scale-[0.98]' 
            : 'border-gray-100 cursor-pointer active:scale-[0.98]'
          } flex overflow-hidden animate-[fadeIn_0.3s_ease-out] transition-transform relative`}
      >
        <div className="w-24 h-auto bg-gray-100 flex-shrink-0 relative">
            {item.Image ? (
                <img src={item.Image} alt={item.Name} className="w-full h-full object-cover absolute inset-0" />
            ) : (
                <div className="flex items-center justify-center h-full text-gray-300">
                    <ImageIcon size={24} />
                </div>
            )}
            
            {(isLowStock || isOutOfStock) && (
              <div className={`absolute bottom-0 w-full ${isOutOfStock ? 'bg-gray-700' : 'bg-red-500/80'} backdrop-blur-sm text-white text-[10px] py-0.5 text-center font-bold`}>
                 {isOutOfStock ? 'نفذت الكمية' : 'مخزون منخفض'}
              </div>
            )}
        </div>

        <div className="flex-1 p-3 flex flex-col justify-between">
          <div className="flex justify-between items-start">
              <div>
                  <h3 className="font-bold text-gray-900 line-clamp-1">{item.Name}</h3>
                  <span className="text-[10px] bg-emerald-50 text-emerald-600 px-2 py-0.5 rounded-full inline-block mt-1">{item.Category}</span>
              </div>
              <div className="flex gap-1">
                  <button onClick={(e) => openEditModal(item, e)} className="p-2 text-blue-400 hover:bg-blue-50 rounded-full">
                      <Edit size={16} />
                  </button>
                  <button onClick={(e) => openDeleteModal(item.id, 'Products', e)} className="p-2 text-red-300 hover:bg-red-50 hover:text-red-500 rounded-full">
                      <Trash2 size={16} />
                  </button>
              </div>
          </div>
          
          <div className="flex justify-between items-end mt-2">
              <div>
                  <p className={`text-xs flex items-center gap-1 ${isOutOfStock ? 'text-gray-500 font-medium' : isLowStock ? 'text-red-600 font-bold' : 'text-gray-400'}`}>
                      {isLowStock && <AlertTriangle size={12} />}
                      {isOutOfStock ? 'غير متوفر' : `المخزون: ${item.Stock}`}
                  </p>
              </div>
              <div className="text-emerald-700 font-bold text-lg">{item.Price} <span className="text-xs font-normal">د.م</span></div>
          </div>
        </div>
      </div>
    );
  };

  const renderSaleCard = (item: Sale) => (
    <div key={item.id} className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex justify-between items-start animate-[fadeIn_0.3s_ease-out]">
      <div className="flex-1">
        <div className="flex justify-between items-start">
          <h3 className="font-bold text-gray-900">{item.ProductName}</h3>
          <span className={`text-[10px] px-2 py-0.5 rounded-full ${item.Status === 'Paid' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>
            {item.Status}
          </span>
        </div>
        <p className="text-xs text-gray-500 mt-1 flex items-center gap-1">
             <User size={10} />
             {item.Customer}
        </p>
        <div className="flex justify-between items-center mt-3">
           <div className="text-sm">
             <span className="text-gray-400 text-xs">x{item.Quantity}</span>
           </div>
           <div className="font-bold text-emerald-600">{item.Total} د.م</div>
        </div>
      </div>
      <div className="flex flex-col gap-1 ml-2">
         {/* Receipt Icon */}
         <button onClick={(e) => openReceiptModal(item, e)} className="text-emerald-600 hover:text-emerald-800 bg-emerald-50 hover:bg-emerald-100 p-2 rounded-lg transition-colors" title="طباعة الإيصال">
            <Printer size={18} />
         </button>
         <button onClick={(e) => openEditModal(item, e)} className="text-blue-300 hover:text-blue-500 p-2">
            <Edit size={18} />
         </button>
         <button onClick={(e) => openDeleteModal(item.id, 'Sales', e)} className="text-red-300 hover:text-red-500 p-2">
            <Trash2 size={18} />
         </button>
      </div>
    </div>
  );

  const renderExpenseCard = (item: Expense) => (
    <div key={item.id} className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex justify-between items-start animate-[fadeIn_0.3s_ease-out]">
      <div className="flex-1 flex gap-3">
        {item.ReceiptImage && (
           <div className="w-16 h-16 rounded-lg bg-gray-50 border border-gray-100 flex-shrink-0 overflow-hidden">
               <img src={item.ReceiptImage} alt="Receipt" className="w-full h-full object-cover" />
           </div>
        )}
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
             <div className="bg-red-50 p-1.5 rounded-lg text-red-500"><Tag size={14} /></div>
             <h3 className="font-bold text-gray-900 line-clamp-1">{item.Type}</h3>
          </div>
          <span className="text-[10px] text-gray-400 border border-gray-100 px-1 rounded">{item.Category}</span>
          <div className="text-2xl font-bold text-gray-800 mt-2">{item.Amount} <span className="text-sm font-normal">د.م</span></div>
          <div className="flex items-center gap-2 mt-2 text-xs text-gray-400">
             <Calendar size={12} />
             <span>{item.Date}</span>
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-1 ml-2">
         <button onClick={(e) => openEditModal(item, e)} className="text-blue-300 hover:text-blue-500 p-2">
            <Edit size={18} />
         </button>
         <button onClick={(e) => openDeleteModal(item.id, 'Expenses', e)} className="text-red-300 hover:text-red-500 p-2">
            <Trash2 size={18} />
         </button>
      </div>
    </div>
  );

  const renderCustomerCard = (item: Customer) => (
    <div key={item.id} className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex justify-between items-start animate-[fadeIn_0.3s_ease-out]">
      <div className="flex-1">
        <div className="flex items-center gap-2 mb-2">
           <div className="bg-blue-50 p-2 rounded-full text-blue-500"><User size={16} /></div>
           <h3 className="font-bold text-gray-900">{item.Name}</h3>
        </div>
        <div className="space-y-1">
           <p className="text-sm text-gray-600">{item.Phone}</p>
           {item.Address && <p className="text-xs text-gray-400 flex items-center gap-1"><MapPin size={10} /> {item.Address}</p>}
           
           <div className="flex justify-between items-end mt-2">
             {item.TotalPurchases > 0 && (
                 <p className="text-xs font-bold text-emerald-600">إجمالي: {item.TotalPurchases} د.م</p>
             )}
             {item.LastPurchase && (
                 <p className="text-[10px] text-gray-400">{item.LastPurchase}</p>
             )}
           </div>
        </div>
      </div>
      <div className="flex flex-col gap-1 ml-2">
         <button onClick={(e) => openEditModal(item, e)} className="text-blue-300 hover:text-blue-500 p-2">
            <Edit size={18} />
         </button>
         <button onClick={(e) => openDeleteModal(item.id, 'Customers', e)} className="text-red-300 hover:text-red-500 p-2">
            <Trash2 size={18} />
         </button>
      </div>
    </div>
  );

  const getCurrentList = () => {
    switch (activeTab) {
      case 'Products': return products.length ? products.map(renderProductCard) : <EmptyState text="لا يوجد منتجات" />;
      case 'Sales': return sales.length ? sales.map(renderSaleCard) : <EmptyState text="لا يوجد مبيعات" />;
      case 'Expenses': return expenses.length ? expenses.map(renderExpenseCard) : <EmptyState text="لا يوجد مصروفات" />;
      case 'Customers': return customers.length ? customers.map(renderCustomerCard) : <EmptyState text="لا يوجد عملاء" />;
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 font-sans text-gray-800 pb-24">
      <Header 
        status={status} 
        onSync={() => handleSync(true)} 
        pendingCount={queueCount} 
        activeTab={activeTab} 
        notifications={notifications}
        onDismissNotification={dismissNotification}
      />

      <main className="max-w-3xl mx-auto p-4 space-y-3">
        {/* Sales Summary Section */}
        {activeTab === 'Sales' && (
          <div className="grid grid-cols-2 gap-3 mb-2">
             <div className="bg-emerald-600 p-4 rounded-xl text-white shadow-lg shadow-emerald-200">
                <div className="flex items-center gap-2 mb-2 opacity-80">
                  <CalendarClock size={16} />
                  <span className="text-xs font-bold">مبيعات اليوم</span>
                </div>
                <div className="text-2xl font-bold">{getSalesSummary().todayTotal} <span className="text-sm font-normal">د.م</span></div>
             </div>
             <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
                <div className="flex items-center gap-2 mb-2 text-emerald-600">
                  <TrendingUp size={16} />
                  <span className="text-xs font-bold">إجمالي المبيعات</span>
                </div>
                <div className="text-2xl font-bold text-gray-800">{getSalesSummary().allTimeTotal} <span className="text-sm font-normal text-gray-400">د.م</span></div>
             </div>
          </div>
        )}

        {getCurrentList()}
      </main>

      {/* Sync Success Toast */}
      {showSyncSuccess && (
        <div className="fixed top-20 left-1/2 transform -translate-x-1/2 bg-gray-800 text-white px-4 py-2 rounded-full flex items-center gap-2 shadow-lg animate-[fadeIn_0.3s_ease-out] z-[70]">
          <CheckCircle size={16} className="text-green-400" />
          <span className="text-sm">تمت المزامنة بنجاح</span>
        </div>
      )}

      {/* Floating Action Button */}
      <button
        onClick={openAddModal}
        className="fixed bottom-20 left-6 bg-emerald-600 text-white w-14 h-14 rounded-full shadow-lg flex items-center justify-center hover:bg-emerald-700 active:scale-90 transition-all z-40"
      >
        <Plus size={32} />
      </button>

      <InputModal
        isOpen={isInputModalOpen}
        onClose={() => setIsInputModalOpen(false)}
        onSubmit={handleSaveItem}
        type={activeTab}
        initialData={editingItem}
      />

      <SaleModal
        isOpen={isSaleModalOpen}
        onClose={() => setIsSaleModalOpen(false)}
        product={selectedProductForSale}
        onSubmit={handleSaleSubmit}
      />
      
      <ConfirmationModal
        isOpen={deleteConfirmation.isOpen}
        onClose={() => setDeleteConfirmation({ ...deleteConfirmation, isOpen: false })}
        onConfirm={executeDelete}
        title="تأكيد الحذف"
        message="هل أنت متأكد من أنك تريد حذف هذا العنصر؟ سيتم حذفه من التطبيق وجوجل شيت عند المزامنة القادمة."
      />
      
      <ReceiptModal
        isOpen={isReceiptModalOpen}
        onClose={() => setIsReceiptModalOpen(false)}
        sale={selectedSaleForReceipt}
      />

      <BottomNav activeTab={activeTab} onTabChange={setActiveTab} />
    </div>
  );
};

const EmptyState = ({ text }: { text: string }) => (
  <div className="flex flex-col items-center justify-center mt-20 text-gray-400">
    <LayoutGrid size={64} className="mb-4 opacity-30" />
    <p className="text-lg">{text}</p>
    <p className="text-sm opacity-60">أضغط على + للإضافة</p>
  </div>
);

export default App;

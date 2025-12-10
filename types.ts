
export type SheetName = 'Products' | 'Sales' | 'Expenses' | 'Customers';

export interface BaseItem {
  id: string;
  ID?: string; // For Google Sheet Compatibility (Header mapping)
  timestamp: number;
  ModifiedAt?: string; // Tracks when the item was last edited
}

export interface Product extends BaseItem {
  Name: string;
  Category: string;
  Price: number;
  Cost: number;
  Stock: number;
  Description: string;
  Image: string; // Base64 string
}

export interface Sale extends BaseItem {
  ProductName: string;
  Quantity: number;
  Price: number;
  Total: number;
  Customer: string;
  Status: 'Paid' | 'Pending' | 'Cancelled';
  InvoiceNumber: string;
  CustomerPhone?: string;
  CustomerAddress?: string;
  Date?: string;
}

export interface Expense extends BaseItem {
  Type: string;
  Amount: number;
  Description: string;
  Category: string;
  Date: string;
  ReceiptImage?: string;
}

export interface Customer extends BaseItem {
  Name: string;
  Email: string; // Maps to Address column in Sheet per user request
  Phone: string;
  Address: string;
  TotalPurchases: number;
  LastPurchase?: string; // Date and Time of last transaction
}

export type AppItem = Product | Sale | Expense | Customer;

export interface SyncQueueItem {
  id: string;
  action: 'ADD' | 'UPDATE' | 'DELETE';
  sheet: SheetName;
  payload: AppItem;
  timestamp: number;
}

export enum NetworkStatus {
  ONLINE = 'ONLINE',
  OFFLINE = 'OFFLINE',
  SYNCING = 'SYNCING'
}

export interface ApiResponse {
  status: 'success' | 'error';
  message?: string;
  data?: any;
}

export interface AppNotification {
  id: string;
  type: 'error' | 'warning' | 'info' | 'success';
  message: string;
}
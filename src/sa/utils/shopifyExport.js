import { isLowStock } from './stockStatus';
import { SA_SKU_VARIANTS, SA_SKU_KEYS } from '../../../shared/sa-sku-variants.js';
/**
 * Export products to Shopify CSV format for inventory sync
 * Format matches Shopify's inventory_bin_new_on_hand_template.csv
 */

export function exportToShopifyCSV(products) {
  // CSV Header (Shopify format)
  const headers = [
    'Handle',
    'Title',
    'Option1 Name',
    'Option1 Value',
    'Option2 Name',
    'Option2 Value',
    'Option3 Name',
    'Option3 Value',
    'SKU',
    'HS Code',
    'COO',
    'Location',
    'Bin name',
    'Incoming (not editable)',
    'Unavailable (not editable)',
    'Committed (not editable)',
    'Available (not editable)',
    'On hand (current)',
    'On hand (new)'
  ];

  const rows = [];

  products.forEach(product => {
    if (product.category === 'OILS' && product.shopifySkus) {
      // Essential oils have 4 variants
      // Labels from shared/sa-sku-variants.js (QA #16) — was a 4th copy.
      const variants = SA_SKU_KEYS.map(k => ({
        name: k, label: SA_SKU_VARIANTS[k].label, sku: product.shopifySkus[k],
      }));

      variants.forEach(variant => {
        if (variant.sku) {
          rows.push([
            product.productCode.toLowerCase().replace(/_/g, '-'), // Handle
            product.name, // Title
            'Format', // Option1 Name
            variant.label, // Option1 Value
            '', // Option2 Name
            '', // Option2 Value
            '', // Option3 Name
            '', // Option3 Value
            variant.sku, // SKU
            '', // HS Code
            '', // COO
            'Scent Australia Warehouse', // Location
            product.tag || '', // Bin name
            '0', // Incoming
            '0', // Unavailable
            '0', // Committed
            product.currentStock, // Available
            product.currentStock, // On hand (current)
            product.currentStock // On hand (new)
          ]);
        }
      });
    } else {
      // Machines and spare parts have single SKU
      const defaultSku = product.shopifySkus?.default || product.productCode;
      
      rows.push([
        product.productCode.toLowerCase().replace(/_/g, '-'), // Handle
        product.name, // Title
        '', // Option1 Name
        '', // Option1 Value
        '', // Option2 Name
        '', // Option2 Value
        '', // Option3 Name
        '', // Option3 Value
        defaultSku, // SKU
        '', // HS Code
        '', // COO
        'Scent Australia Warehouse', // Location
        product.tag || '', // Bin name
        '0', // Incoming
        '0', // Unavailable
        '0', // Committed
        product.currentStock, // Available
        product.currentStock, // On hand (current)
        product.currentStock // On hand (new)
      ]);
    }
  });

  // Convert to CSV string
  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.map(cell => {
      // Escape cells containing commas or quotes
      const cellStr = String(cell || '');
      if (cellStr.includes(',') || cellStr.includes('"') || cellStr.includes('\n')) {
        return `"${cellStr.replace(/"/g, '""')}"`;
      }
      return cellStr;
    }).join(','))
  ].join('\n');

  // Create download
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  
  const timestamp = new Date().toISOString().split('T')[0];
  link.setAttribute('href', url);
  link.setAttribute('download', `Shopify_Inventory_${timestamp}.csv`);
  link.style.visibility = 'hidden';
  
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * Export only products with low stock to Shopify CSV
 */
export function exportLowStockToShopifyCSV(products) {
  const lowStockProducts = products.filter(isLowStock);
  exportToShopifyCSV(lowStockProducts);
}

/**
 * Export by category to Shopify CSV
 */
export function exportCategoryToShopifyCSV(products, category) {
  const categoryProducts = products.filter(p => p.category === category);
  exportToShopifyCSV(categoryProducts);
}

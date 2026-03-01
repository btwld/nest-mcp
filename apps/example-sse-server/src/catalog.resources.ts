import { Prompt, Resource } from '@nest-mcp/server';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

@Injectable()
export class CatalogResources {
  @Resource({
    uri: 'inventory://catalog/products',
    name: 'Product Catalog',
    description: 'Complete product catalog listing',
    mimeType: 'application/json',
  })
  async getProductCatalog() {
    return {
      contents: [
        {
          uri: 'inventory://catalog/products',
          mimeType: 'application/json',
          text: JSON.stringify({
            catalog: [
              { id: 'SKU-001', name: 'Wireless Mouse', price: 29.99, category: 'electronics' },
              { id: 'SKU-002', name: 'USB-C Cable', price: 12.99, category: 'electronics' },
              { id: 'SKU-003', name: 'Standing Desk Mat', price: 49.99, category: 'office' },
              { id: 'SKU-004', name: 'Mechanical Keyboard', price: 89.99, category: 'electronics' },
              { id: 'SKU-005', name: 'Monitor Stand', price: 34.99, category: 'office' },
            ],
            lastUpdated: new Date().toISOString(),
          }),
        },
      ],
    };
  }

  @Prompt({
    name: 'inventory_summary',
    description: 'Generate an inventory status summary report',
    parameters: z.object({
      category: z.string().optional().describe('Filter by product category'),
      includeOutOfStock: z.boolean().optional().describe('Include out-of-stock items'),
    }),
  })
  async inventorySummary(args: { category?: string; includeOutOfStock?: boolean }) {
    const filter = args.category ? ` for the "${args.category}" category` : '';
    const stockFilter = args.includeOutOfStock === false ? ' (excluding out-of-stock items)' : '';

    return {
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Please provide a summary of current inventory levels${filter}${stockFilter}. Include stock quantities, warehouse locations, and highlight any items that need restocking (below 50 units).`,
          },
        },
      ],
    };
  }
}

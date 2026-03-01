import { Tool } from '@nest-mcp/server';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

// Simulated product database
const products = new Map([
  ['SKU-001', { id: 'SKU-001', name: 'Wireless Mouse', price: 29.99, category: 'electronics' }],
  ['SKU-002', { id: 'SKU-002', name: 'USB-C Cable', price: 12.99, category: 'electronics' }],
  ['SKU-003', { id: 'SKU-003', name: 'Standing Desk Mat', price: 49.99, category: 'office' }],
  [
    'SKU-004',
    { id: 'SKU-004', name: 'Mechanical Keyboard', price: 89.99, category: 'electronics' },
  ],
  ['SKU-005', { id: 'SKU-005', name: 'Monitor Stand', price: 34.99, category: 'office' }],
]);

// Simulated stock levels
const stock = new Map([
  ['SKU-001', { quantity: 150, warehouse: 'US-EAST' }],
  ['SKU-002', { quantity: 500, warehouse: 'US-EAST' }],
  ['SKU-003', { quantity: 30, warehouse: 'US-WEST' }],
  ['SKU-004', { quantity: 0, warehouse: 'US-EAST' }],
  ['SKU-005', { quantity: 75, warehouse: 'US-WEST' }],
]);

@Injectable()
export class InventoryTools {
  @Tool({
    name: 'lookup_product',
    description: 'Look up product details by SKU or search by name',
    parameters: z.object({
      sku: z.string().optional().describe('Product SKU (e.g. SKU-001)'),
      query: z.string().optional().describe('Search query for product name'),
    }),
  })
  async lookupProduct(args: { sku?: string; query?: string }) {
    if (args.sku) {
      const product = products.get(args.sku);
      if (!product) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'Product not found', sku: args.sku }),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(product) }],
      };
    }

    if (args.query) {
      const query = args.query.toLowerCase();
      const matches = Array.from(products.values()).filter((p) =>
        p.name.toLowerCase().includes(query),
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ results: matches, count: matches.length }),
          },
        ],
      };
    }

    // Return all products if no filter
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ results: Array.from(products.values()), count: products.size }),
        },
      ],
    };
  }

  @Tool({
    name: 'check_stock',
    description: 'Check stock availability for a product by SKU',
    parameters: z.object({
      sku: z.string().describe('Product SKU to check stock for'),
    }),
  })
  async checkStock(args: { sku: string }) {
    const product = products.get(args.sku);
    if (!product) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: 'Product not found', sku: args.sku }),
          },
        ],
        isError: true,
      };
    }

    const stockInfo = stock.get(args.sku);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            sku: args.sku,
            product: product.name,
            inStock: (stockInfo?.quantity ?? 0) > 0,
            quantity: stockInfo?.quantity ?? 0,
            warehouse: stockInfo?.warehouse ?? 'unknown',
          }),
        },
      ],
    };
  }
}

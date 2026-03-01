import { Public, Tool } from '@nest-mcp/server';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

@Injectable()
export class CalculatorTools {
  @Tool({
    name: 'calculate',
    description: 'Perform basic arithmetic operations',
    parameters: z.object({
      operation: z.enum(['add', 'subtract', 'multiply', 'divide']).describe('Arithmetic operation'),
      a: z.number().describe('First number'),
      b: z.number().describe('Second number'),
    }),
    annotations: { readOnlyHint: true },
  })
  @Public()
  async calculate(args: { operation: string; a: number; b: number }) {
    let result: number;

    switch (args.operation) {
      case 'add':
        result = args.a + args.b;
        break;
      case 'subtract':
        result = args.a - args.b;
        break;
      case 'multiply':
        result = args.a * args.b;
        break;
      case 'divide':
        if (args.b === 0) {
          return {
            content: [{ type: 'text' as const, text: 'Error: Division by zero' }],
            isError: true,
          };
        }
        result = args.a / args.b;
        break;
      default:
        return {
          content: [{ type: 'text' as const, text: `Unknown operation: ${args.operation}` }],
          isError: true,
        };
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ operation: args.operation, a: args.a, b: args.b, result }),
        },
      ],
    };
  }

  @Tool({
    name: 'convert_units',
    description: 'Convert temperature between Celsius and Fahrenheit',
    parameters: z.object({
      value: z.number().describe('Temperature value'),
      from: z.enum(['celsius', 'fahrenheit']).describe('Source unit'),
      to: z.enum(['celsius', 'fahrenheit']).describe('Target unit'),
    }),
    annotations: { readOnlyHint: true },
  })
  @Public()
  async convertUnits(args: { value: number; from: string; to: string }) {
    let result: number;

    if (args.from === args.to) {
      result = args.value;
    } else if (args.from === 'celsius' && args.to === 'fahrenheit') {
      result = (args.value * 9) / 5 + 32;
    } else {
      result = ((args.value - 32) * 5) / 9;
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            value: args.value,
            from: args.from,
            to: args.to,
            result: Math.round(result * 100) / 100,
          }),
        },
      ],
    };
  }
}

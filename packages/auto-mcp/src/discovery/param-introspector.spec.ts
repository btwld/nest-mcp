import 'reflect-metadata';
import { Body, Controller, Get, Headers, Param, Post, Query } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { introspectParams } from './param-introspector';

class CreateDto {
  name!: string;
}

@Controller('demo')
class DemoController {
  @Get(':id')
  one(
    @Param('id') _id: string,
    @Query('limit') _limit: number,
    @Headers('x-trace') _trace: string,
  ): unknown {
    return null;
  }

  @Post()
  create(@Body() _body: CreateDto): unknown {
    return null;
  }
}

describe('introspectParams', () => {
  const ctrl = new DemoController();

  it('decodes path/query/header params with their data keys', () => {
    const params = introspectParams(ctrl, 'one');
    expect(params.map((p) => `${p.kind}:${p.data ?? ''}`)).toEqual([
      'param:id',
      'query:limit',
      'headers:x-trace',
    ]);
  });

  it('decodes whole-body params with kind=body and no data key', () => {
    const params = introspectParams(ctrl, 'create');
    expect(params).toHaveLength(1);
    expect(params[0]).toMatchObject({ kind: 'body', data: undefined });
    // metaType comes from design:paramtypes which Vitest's transformer may or may
    // not emit for spec-file inline classes. The end-to-end module spec
    // exercises it via Nest bootstrap, so we don't assert it here.
  });
});

import { Body, Controller, Delete, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { IsEmail, IsString } from 'class-validator';

export class CreateUserDto {
  @IsString()
  name!: string;

  @IsEmail()
  email!: string;
}

interface User {
  id: string;
  name: string;
  email: string;
}

/**
 * A plain NestJS controller. None of the following lines mention MCP. The
 * `@nest-mcp/auto-mcp` module discovers these routes at boot time and exposes
 * each one as an MCP tool — `nestjs.users.findOne`, `nestjs.users.create`,
 * `nestjs.users.remove`.
 */
@Controller('users')
export class UsersController {
  private readonly users = new Map<string, User>();

  @Get(':id')
  findOne(@Param('id') id: string): User {
    const user = this.users.get(id);
    if (!user) throw new NotFoundException(`User ${id} not found`);
    return user;
  }

  @Post()
  create(@Body() body: CreateUserDto): User {
    const id = String(this.users.size + 1);
    const user: User = { id, name: body.name, email: body.email };
    this.users.set(id, user);
    return user;
  }

  @Delete(':id')
  remove(@Param('id') id: string): { ok: boolean } {
    return { ok: this.users.delete(id) };
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  addMemberSchema,
  createOrganizationSchema,
  updateMemberRoleSchema,
  updateOrganizationSchema,
  type AddMemberInput,
  type CreateOrganizationInput,
  type MemberDto,
  type MembershipDto,
  type OrganizationDetailDto,
  type UpdateMemberRoleInput,
  type UpdateOrganizationInput,
} from '@nexus/shared';
import { ApiError } from '../common/api-error';
import type { AppRequest, TenantContext } from '../common/request-context';
import { UuidParamPipe, ZodValidationPipe } from '../common/zod.pipe';
import { AuthenticatedOnly, RequirePermission } from '../rbac/decorators';
import { MembersService } from './members.service';
import { OrganizationsService } from './organizations.service';

function tenantOf(request: AppRequest): TenantContext {
  // Set by OrgAccessGuard; absence means a route was mounted without the guard, so fail closed.
  if (!request.tenant) throw ApiError.forbidden('ROUTE_MISCONFIGURED', 'Access denied');
  return request.tenant;
}

@ApiTags('organizations')
@Controller('orgs')
export class OrganizationsController {
  constructor(@Inject(OrganizationsService) private readonly orgs: OrganizationsService) {}

  @AuthenticatedOnly()
  @Post()
  @ApiOperation({ summary: 'Create an organisation; the caller becomes its owner' })
  create(
    @Body(new ZodValidationPipe(createOrganizationSchema)) body: CreateOrganizationInput,
    @Req() request: AppRequest,
  ): Promise<OrganizationDetailDto> {
    if (!request.auth) throw ApiError.unauthenticated();
    return this.orgs.create(request.auth.user.id, body.name);
  }

  @AuthenticatedOnly()
  @Get()
  @ApiOperation({ summary: 'Organisations the caller belongs to' })
  async list(@Req() request: AppRequest): Promise<{ data: MembershipDto[] }> {
    if (!request.auth) throw ApiError.unauthenticated();
    return { data: await this.orgs.listForUser(request.auth.user.id) };
  }

  @RequirePermission('organization.read')
  @Get(':orgId')
  @ApiOperation({ summary: 'Organisation details' })
  get(@Req() request: AppRequest): Promise<OrganizationDetailDto> {
    return this.orgs.get(tenantOf(request));
  }

  @RequirePermission('organization.update')
  @Patch(':orgId')
  @ApiOperation({ summary: 'Update organisation settings' })
  update(
    @Body(new ZodValidationPipe(updateOrganizationSchema)) body: UpdateOrganizationInput,
    @Req() request: AppRequest,
  ): Promise<OrganizationDetailDto> {
    return this.orgs.update(tenantOf(request), body.name);
  }
}

@ApiTags('members')
@Controller('orgs/:orgId/members')
export class MembersController {
  constructor(@Inject(MembersService) private readonly members: MembersService) {}

  @RequirePermission('users.read')
  @Get()
  @ApiOperation({ summary: 'List organisation members' })
  async list(@Req() request: AppRequest): Promise<{ data: MemberDto[] }> {
    return { data: await this.members.list(tenantOf(request)) };
  }

  @RequirePermission('users.manage')
  @Post()
  @ApiOperation({ summary: 'Add an existing user to the organisation' })
  add(
    @Body(new ZodValidationPipe(addMemberSchema)) body: AddMemberInput,
    @Req() request: AppRequest,
  ): Promise<MemberDto> {
    return this.members.add(tenantOf(request), body);
  }

  @RequirePermission('users.manage')
  @Patch(':memberId')
  @ApiOperation({ summary: "Change a member's role" })
  changeRole(
    @Param('memberId', new UuidParamPipe()) memberId: string,
    @Body(new ZodValidationPipe(updateMemberRoleSchema)) body: UpdateMemberRoleInput,
    @Req() request: AppRequest,
  ): Promise<MemberDto> {
    return this.members.changeRole(tenantOf(request), memberId, body.role);
  }

  @RequirePermission('users.manage')
  @Delete(':memberId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a member' })
  remove(
    @Param('memberId', new UuidParamPipe()) memberId: string,
    @Req() request: AppRequest,
  ): Promise<void> {
    return this.members.remove(tenantOf(request), memberId);
  }
}

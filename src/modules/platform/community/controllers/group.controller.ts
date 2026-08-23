import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CurrentUserId,
  Idempotent,
  JwtAuthGuard,
  PageOptionsDto,
  SuccessMessage,
  RateLimit,
} from '@/common';
import {
  CreateGroupDto,
  CreateGroupPostDto,
  CreateGroupPostReplyDto,
  JoinDecisionDto,
  ListGroupsDto,
  UpdateGroupDto,
} from '../dtos/group.dto';
import { GroupService } from '../services/group.service';

@Controller('community/groups')
@ApiTags('Community · Groups')
@UseGuards(JwtAuthGuard)
export class GroupController {
  constructor(private readonly groups: GroupService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List groups',
    description:
      'Backs the My groups strip, the Groups near you list, and the full Groups List screen. ' +
      '`viewer.membership` is the single source of truth for whether the button reads Join, ' +
      'Pending or Leave.',
  })
  async list(@CurrentUserId() userId: string, @Query() query: ListGroupsDto) {
    const { data, meta } = await this.groups.list(userId, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Groups') };
  }

  @Post()
  @Idempotent()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a group',
    description: 'The creator becomes the first member and the first admin.',
  })
  @RateLimit('CREATE')
  async create(@CurrentUserId() userId: string, @Body() dto: CreateGroupDto) {
    const data = await this.groups.create(userId, dto);

    return { data, message: SuccessMessage.RESOURCE_CREATED('Group') };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Group detail' })
  async findOne(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.groups.findOne(userId, id);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Group') };
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Edit a group', description: 'Admin only.' })
  async update(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateGroupDto,
  ) {
    const data = await this.groups.update(userId, id, dto);

    return { data, message: SuccessMessage.RESOURCE_UPDATED('Group') };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a group', description: 'Admin only. Cascades to posts.' })
  async remove(@CurrentUserId() userId: string, @Param('id') id: string) {
    await this.groups.remove(userId, id);
  }

  // ─── Membership (1.7.4) ────────────────────────────────────────────────────

  @Post(':id/join')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Join, or request to join',
    description:
      'OPEN policy joins immediately; APPROVAL creates a pending request and notifies the admins. ' +
      'Returns the updated viewer state and memberCount so the client reconciles without a refetch.',
  })
  @RateLimit('REACT')
  async join(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.groups.join(userId, id);

    return { data, message: 'Membership updated' };
  }

  @Delete(':id/join')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Leave, or withdraw a pending request',
    description: 'The last admin of a group with other members in it cannot leave.',
  })
  @RateLimit('REACT')
  async leave(@CurrentUserId() userId: string, @Param('id') id: string) {
    const data = await this.groups.leave(userId, id);

    return { data, message: 'Membership updated' };
  }

  @Get(':id/join-requests')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'The approval queue', description: 'Admin only.' })
  async listJoinRequests(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Query() query: PageOptionsDto,
  ) {
    const { data, meta } = await this.groups.listJoinRequests(userId, id, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Join requests') };
  }

  @Post(':id/join-requests/:userId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve or reject a join request', description: 'Admin only.' })
  async decideJoinRequest(
    @CurrentUserId() adminId: string,
    @Param('id') id: string,
    @Param('userId') subjectUserId: string,
    @Body() dto: JoinDecisionDto,
  ) {
    const data = await this.groups.decideJoinRequest(adminId, id, subjectUserId, dto.decision);

    return { data, message: 'Request decided' };
  }

  @Delete(':id/members/:userId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a member', description: 'Admin only.' })
  async removeMember(
    @CurrentUserId() adminId: string,
    @Param('id') id: string,
    @Param('userId') subjectUserId: string,
  ) {
    const data = await this.groups.removeMember(adminId, id, subjectUserId);

    return { data, message: 'Member removed' };
  }

  // ─── Posts and replies (1.7.5) ─────────────────────────────────────────────

  @Get(':id/posts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The group wall',
    description:
      'Members get the full wall. A non-member gets a truncated preview of the last 3 posts with ' +
      '`meta.preview: true` — truncated here rather than sent in full for the client to blur, ' +
      'because anyone can read blurred text off the wire.',
  })
  async listPosts(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Query() query: PageOptionsDto,
  ) {
    const { data, meta } = await this.groups.listPosts(userId, id, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Posts') };
  }

  @Post(':id/posts')
  @Idempotent()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Post to a group', description: 'Members only, always.' })
  @RateLimit('CREATE')
  async createPost(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: CreateGroupPostDto,
  ) {
    const data = await this.groups.createPost(userId, id, dto);

    return { data, message: SuccessMessage.RESOURCE_CREATED('Post') };
  }

  @Delete(':id/posts/:postId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a group post' })
  async removePost(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Param('postId') postId: string,
  ) {
    await this.groups.removePost(userId, id, postId);
  }

  @Get(':groupId/posts/:postId/replies')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Replies to a group post',
    description:
      'Returns the parent post alongside the page of replies, so the screen is reachable from a ' +
      'deep link or a cold start rather than only from an in-memory push.',
  })
  async listPostReplies(
    @CurrentUserId() userId: string,
    @Param('groupId') groupId: string,
    @Param('postId') postId: string,
    @Query() query: PageOptionsDto,
  ) {
    const { data, meta } = await this.groups.listPostReplies(userId, groupId, postId, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Replies') };
  }

  @Post(':groupId/posts/:postId/replies')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Reply to a group post', description: 'One level deep.' })
  @RateLimit('CREATE')
  async createPostReply(
    @CurrentUserId() userId: string,
    @Param('groupId') groupId: string,
    @Param('postId') postId: string,
    @Body() dto: CreateGroupPostReplyDto,
  ) {
    const data = await this.groups.createPostReply(userId, groupId, postId, dto);

    return { data, message: 'Reply posted' };
  }

  @Delete(':groupId/posts/:postId/replies/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a group post reply' })
  async removePostReply(
    @CurrentUserId() userId: string,
    @Param('groupId') groupId: string,
    @Param('postId') postId: string,
    @Param('id') id: string,
  ) {
    await this.groups.removePostReply(userId, groupId, postId, id);
  }
}

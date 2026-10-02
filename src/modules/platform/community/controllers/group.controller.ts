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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
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
  InviteAnswerDto,
  InviteMembersDto,
  JoinDecisionDto,
  JoinGroupDto,
  ListGroupsDto,
  MuteGroupDto,
  SearchPageDto,
  UpdateGroupDto,
} from '../dtos/group.dto';
import { GroupService } from '../services/group.service';

@ApiBearerAuth()
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

  @Get('invites')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'My group invitations',
    description:
      'Every invitation waiting on the caller, with the group each is for. Shown at the top of ' +
      'the Groups screen rather than buried in a feed. Declared before `:id` on purpose, or the ' +
      'word "invites" would be read as a group id.',
  })
  async myInvitations(@CurrentUserId() userId: string) {
    const data = await this.groups.myInvitations(userId);

    return { data, message: SuccessMessage.RESOURCE_FETCHED('Invitations') };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Group detail',
    description:
      "One group with its member preview, admins and the caller's own membership state. Pending " +
      'members see that they are pending.',
  })
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
  async join(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: JoinGroupDto,
  ) {
    const data = await this.groups.join(userId, id, dto);

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

  @Patch(':id/mute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mute or unmute a group',
    description:
      'Per member, never for the group. Answers the whole group, so `viewer.isMuted` comes back ' +
      'with it. A muted group still counts its unread; it simply does not notify.',
  })
  async setMuted(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: MuteGroupDto,
  ) {
    const data = await this.groups.setMuted(userId, id, dto.isMuted);

    return { data, message: dto.isMuted ? 'Group muted' : 'Group unmuted' };
  }

  @Get(':id/members')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Who is in a group',
    description:
      'Members only: who is in a group is not public, even for one a stranger may read. `q` ' +
      'searches names. Each row carries the member\'s `headline` under their name, where they ' +
      'have said what they do.',
  })
  async listMembers(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Query() query: SearchPageDto,
  ) {
    const { data, meta } = await this.groups.listMembers(userId, id, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Members') };
  }

  @Get(':id/invitable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Who an admin can still invite',
    description:
      'Admin only. Members of Circl not in the group and with no invitation outstanding. ' +
      'Somebody the admin removed before stays listed, because an invitation is the only way ' +
      'back in, and carries `wasRemoved: true` so the admin knows who they are re-admitting.',
  })
  async listInvitable(
    @CurrentUserId() adminId: string,
    @Param('id') id: string,
    @Query() query: SearchPageDto,
  ) {
    const { data, meta } = await this.groups.listInvitable(adminId, id, query);

    return { data, meta, message: SuccessMessage.RESOURCE_FETCHED('Invitable members') };
  }

  @Post(':id/invites')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Invite members',
    description:
      'Admin only, several at once. Inviting somebody already invited is not an error. Each one ' +
      'is notified. Answers the whole group.',
  })
  @RateLimit('REACT')
  async invite(
    @CurrentUserId() adminId: string,
    @Param('id') id: string,
    @Body() dto: InviteMembersDto,
  ) {
    const data = await this.groups.invite(adminId, id, dto);

    return { data, message: 'Invitations sent' };
  }

  @Post(':id/invites/answer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept or decline an invitation',
    description:
      'The `{id}` may be the group\'s or the invitation\'s; the client sends the group\'s, which ' +
      'is what every screen holds. Accepting answers the whole group, now joined; declining ' +
      'answers nothing and the invitation is gone.',
  })
  async answerInvitation(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() dto: InviteAnswerDto,
  ) {
    const data = await this.groups.answerInvitation(userId, id, dto.accept);

    return { data, message: dto.accept ? 'Invitation accepted' : 'Invitation declined' };
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
    const data = await this.groups.decideJoinRequest(
      adminId,
      id,
      subjectUserId,
      dto.decision ?? (dto.approve ? 'APPROVE' : 'REJECT'),
    );

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

  // ─── Posts and replies (1.7.5) — retired, see the note on each route ───────

  @Get(':id/posts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The group wall (retired)',
    deprecated: true,
    description:
      '**Retired 2026-10-02.** A group is its conversation, so the wall was a second, quieter place to say the same things, with its own replies and its own unread story. The app no longer calls this. Kept running rather than removed or made to answer 410, because builds in the wild still call it until people update; nothing new should be built on it, and the posts stay readable for moderation. ' +
      'Members get the full wall. A non-member of an open group gets a truncated preview of the ' +
      'last 3 posts with `meta.preview: true`; a closed group refuses them.',
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
  @ApiOperation({
    summary: 'Post to a group (retired)',
    deprecated: true,
    description: '**Retired 2026-10-02.** A group is its conversation, so the wall was a second, quieter place to say the same things, with its own replies and its own unread story. The app no longer calls this. Kept running rather than removed or made to answer 410, because builds in the wild still call it until people update; nothing new should be built on it, and the posts stay readable for moderation. Members only, always.',
  })
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
  @ApiOperation({
    summary: 'Delete a group post (retired)',
    deprecated: true,
    description: '**Retired 2026-10-02 with the wall.** The app no longer calls this. Kept running rather than removed or made to answer 410, because builds in the wild still call it until people update. The author or a group admin. Replies go with it.',
  })
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
    summary: 'Replies to a group post (retired)',
    deprecated: true,
    description:
      '**Retired 2026-10-02 with the wall.** The app no longer calls this. Kept running rather than removed or made to answer 410, because builds in the wild still call it until people update. Returns the parent post alongside the page of ' +
      'replies, so the screen was reachable from a deep link rather than only from a push.',
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
  @ApiOperation({
    summary: 'Reply to a group post (retired)',
    deprecated: true,
    description:
      '**Retired 2026-10-02 with the wall.** The app no longer calls this. Kept running rather than removed or made to answer 410, because builds in the wild still call it until people update. One level deep. Its notification opens the ' +
      'group rather than the post, since there is no post screen left to open.',
  })
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
  @ApiOperation({
    summary: 'Delete a group post reply (retired)',
    deprecated: true,
    description: '**Retired 2026-10-02 with the wall.** The app no longer calls this. Kept running rather than removed or made to answer 410, because builds in the wild still call it until people update. The reply\'s author, or a group admin.',
  })
  async removePostReply(
    @CurrentUserId() userId: string,
    @Param('groupId') groupId: string,
    @Param('postId') postId: string,
    @Param('id') id: string,
  ) {
    await this.groups.removePostReply(userId, groupId, postId, id);
  }
}

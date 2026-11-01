export const canEditPost = (thread, me) => !!thread && !!me && thread.createdBy?.id === me.id;

export const canDeletePost = (thread, me, { canManage = false } = {}) =>
  canEditPost(thread, me) || !!canManage || !!me?.isSiteAdmin;

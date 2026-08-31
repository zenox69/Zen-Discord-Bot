-- CreateEnum
CREATE TYPE "LeavePolicy" AS ENUM ('RESET_ON_LEAVE', 'KEEP_ORIGINAL', 'STAFF_REVIEW');

-- CreateEnum
CREATE TYPE "MembershipDateSource" AS ENUM ('FIRST_SEEN', 'STAFF_VERIFIED', 'IMPORTED', 'OFFICIAL_API');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'STAFF_REVIEW', 'QUOTED', 'AWAITING_PAYMENT', 'PAID', 'IN_PROGRESS', 'READY', 'COMPLETED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "TicketType" AS ENUM ('ORDER', 'SUPPORT');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "AuditCategory" AS ENUM ('VERIFICATION', 'TICKET', 'ORDER', 'ELIGIBILITY', 'COMMUNITY', 'PRODUCT', 'SYSTEM');

-- CreateTable
CREATE TABLE "discord_guilds" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discord_guilds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guild_settings" (
    "guildId" TEXT NOT NULL,
    "marketplaceName" TEXT NOT NULL DEFAULT 'Marketplace',
    "staffRoleId" TEXT,
    "adminRoleId" TEXT,
    "ticketCategoryId" TEXT,
    "orderPanelChannelId" TEXT,
    "orderLogChannelId" TEXT,
    "ticketLogChannelId" TEXT,
    "eligibilityLogChannelId" TEXT,
    "verificationLogChannelId" TEXT,
    "errorLogChannelId" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Manila',
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "currencySymbol" TEXT NOT NULL DEFAULT '₱',
    "ticketCounter" INTEGER NOT NULL DEFAULT 0,
    "orderCounter" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guild_settings_pkey" PRIMARY KEY ("guildId")
);

-- CreateTable
CREATE TABLE "discord_users" (
    "guildId" TEXT NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "notes" TEXT,
    "warnings" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discord_users_pkey" PRIMARY KEY ("guildId","discordUserId")
);

-- CreateTable
CREATE TABLE "roblox_accounts" (
    "id" SERIAL NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "robloxUserId" TEXT NOT NULL,
    "robloxUsername" TEXT NOT NULL,
    "robloxDisplayName" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "linkedByDiscordId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roblox_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roblox_verifications" (
    "id" SERIAL NOT NULL,
    "guildId" TEXT NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "robloxUserId" TEXT NOT NULL,
    "robloxUsername" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roblox_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roblox_communities" (
    "id" SERIAL NOT NULL,
    "guildId" TEXT NOT NULL,
    "robloxGroupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "requiredDays" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "emoji" TEXT,
    "inviteUrl" TEXT,
    "notes" TEXT,
    "leavePolicy" "LeavePolicy" NOT NULL DEFAULT 'RESET_ON_LEAVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roblox_communities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_memberships" (
    "id" SERIAL NOT NULL,
    "robloxUserId" TEXT NOT NULL,
    "communityId" INTEGER NOT NULL,
    "isCurrentlyMember" BOOLEAN NOT NULL DEFAULT false,
    "membershipFirstSeenAt" TIMESTAMP(3) NOT NULL,
    "membershipStartedAt" TIMESTAMP(3) NOT NULL,
    "membershipDateSource" "MembershipDateSource" NOT NULL DEFAULT 'FIRST_SEEN',
    "roleId" INTEGER,
    "roleName" TEXT,
    "rank" INTEGER,
    "lastMembershipCheckAt" TIMESTAMP(3) NOT NULL,
    "membershipSeenAt" TIMESTAMP(3),
    "leftAt" TIMESTAMP(3),
    "rejoinedAt" TIMESTAMP(3),
    "eligibilityNotificationSentAt" TIMESTAMP(3),
    "eligibilityNotificationLastAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "community_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eligibility_overrides" (
    "id" SERIAL NOT NULL,
    "membershipId" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "previousStartedAt" TIMESTAMP(3),
    "reason" TEXT NOT NULL,
    "setByDiscordId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eligibility_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" SERIAL NOT NULL,
    "guildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "requiresEligibility" BOOLEAN NOT NULL DEFAULT true,
    "minQuantity" INTEGER NOT NULL DEFAULT 1,
    "maxQuantity" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_communities" (
    "productId" INTEGER NOT NULL,
    "communityId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_communities_pkey" PRIMARY KEY ("productId","communityId")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" SERIAL NOT NULL,
    "number" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "ticketId" INTEGER,
    "discordUserId" TEXT NOT NULL,
    "robloxUserId" TEXT,
    "robloxUsername" TEXT,
    "productId" INTEGER NOT NULL,
    "communityId" INTEGER,
    "quantity" INTEGER NOT NULL,
    "details" TEXT,
    "preferredOption" TEXT,
    "notes" TEXT,
    "price" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "status" "OrderStatus" NOT NULL DEFAULT 'SUBMITTED',
    "assignedStaffId" TEXT,
    "eligibilitySnapshot" JSONB,
    "orderMessageId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_events" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "fromStatus" "OrderStatus",
    "toStatus" "OrderStatus",
    "actorDiscordId" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_assignments" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "staffDiscordId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unassignedAt" TIMESTAMP(3),

    CONSTRAINT "staff_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" SERIAL NOT NULL,
    "guildId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "type" "TicketType" NOT NULL,
    "channelName" TEXT NOT NULL,
    "channelId" TEXT,
    "channelMessageId" TEXT,
    "discordUserId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "orderId" INTEGER,
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "closedByDiscordId" TEXT,
    "closeReason" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_events" (
    "id" SERIAL NOT NULL,
    "ticketId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "actorDiscordId" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" SERIAL NOT NULL,
    "guildId" TEXT,
    "category" "AuditCategory" NOT NULL,
    "action" TEXT NOT NULL,
    "actorDiscordId" TEXT,
    "targetDiscordId" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roblox_accounts_discordUserId_key" ON "roblox_accounts"("discordUserId");

-- CreateIndex
CREATE UNIQUE INDEX "roblox_accounts_robloxUserId_key" ON "roblox_accounts"("robloxUserId");

-- CreateIndex
CREATE INDEX "roblox_accounts_robloxUserId_idx" ON "roblox_accounts"("robloxUserId");

-- CreateIndex
CREATE UNIQUE INDEX "roblox_verifications_code_key" ON "roblox_verifications"("code");

-- CreateIndex
CREATE INDEX "roblox_verifications_discordUserId_guildId_idx" ON "roblox_verifications"("discordUserId", "guildId");

-- CreateIndex
CREATE INDEX "roblox_verifications_expiresAt_idx" ON "roblox_verifications"("expiresAt");

-- CreateIndex
CREATE INDEX "roblox_communities_guildId_enabled_idx" ON "roblox_communities"("guildId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "roblox_communities_guildId_robloxGroupId_key" ON "roblox_communities"("guildId", "robloxGroupId");

-- CreateIndex
CREATE INDEX "community_memberships_communityId_isCurrentlyMember_idx" ON "community_memberships"("communityId", "isCurrentlyMember");

-- CreateIndex
CREATE INDEX "community_memberships_robloxUserId_isCurrentlyMember_idx" ON "community_memberships"("robloxUserId", "isCurrentlyMember");

-- CreateIndex
CREATE UNIQUE INDEX "community_memberships_robloxUserId_communityId_key" ON "community_memberships"("robloxUserId", "communityId");

-- CreateIndex
CREATE INDEX "eligibility_overrides_membershipId_idx" ON "eligibility_overrides"("membershipId");

-- CreateIndex
CREATE INDEX "products_guildId_enabled_idx" ON "products"("guildId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "products_guildId_name_key" ON "products"("guildId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "orders_ticketId_key" ON "orders"("ticketId");

-- CreateIndex
CREATE INDEX "orders_guildId_status_idx" ON "orders"("guildId", "status");

-- CreateIndex
CREATE INDEX "orders_discordUserId_idx" ON "orders"("discordUserId");

-- CreateIndex
CREATE INDEX "orders_assignedStaffId_idx" ON "orders"("assignedStaffId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_guildId_number_key" ON "orders"("guildId", "number");

-- CreateIndex
CREATE INDEX "order_events_orderId_createdAt_idx" ON "order_events"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "staff_assignments_orderId_idx" ON "staff_assignments"("orderId");

-- CreateIndex
CREATE INDEX "staff_assignments_staffDiscordId_unassignedAt_idx" ON "staff_assignments"("staffDiscordId", "unassignedAt");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_channelId_key" ON "tickets"("channelId");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_orderId_key" ON "tickets"("orderId");

-- CreateIndex
CREATE INDEX "tickets_guildId_status_idx" ON "tickets"("guildId", "status");

-- CreateIndex
CREATE INDEX "tickets_discordUserId_status_idx" ON "tickets"("discordUserId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_guildId_channelName_key" ON "tickets"("guildId", "channelName");

-- CreateIndex
CREATE INDEX "ticket_events_ticketId_createdAt_idx" ON "ticket_events"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_guildId_category_createdAt_idx" ON "audit_logs"("guildId", "category", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- AddForeignKey
ALTER TABLE "guild_settings" ADD CONSTRAINT "guild_settings_guildId_fkey" FOREIGN KEY ("guildId") REFERENCES "discord_guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_memberships" ADD CONSTRAINT "community_memberships_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "roblox_communities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eligibility_overrides" ADD CONSTRAINT "eligibility_overrides_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "community_memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_communities" ADD CONSTRAINT "product_communities_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_communities" ADD CONSTRAINT "product_communities_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "roblox_communities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "roblox_communities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

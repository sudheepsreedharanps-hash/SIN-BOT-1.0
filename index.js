require("dotenv").config();

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const {
    Client,
    GatewayIntentBits,
    PermissionsBitField,
    ChannelType,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    SlashCommandBuilder,
    REST,
    Routes,
    Events,
    ActivityType
} = require("discord.js");

// =====================================================
// S1N GUILD BOT CONFIG
// =====================================================

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_OAUTH_REDIRECT_URI = process.env.DISCORD_OAUTH_REDIRECT_URI;
const S1N_WEBSITE_URL = process.env.S1N_WEBSITE_URL || "https://s1ngambles.netlify.app";
const API_PORT = process.env.PORT || 3000;

const WELCOME_LEAVE_CHANNEL_ID = "1511076324989735044";
const BIRTHDAY_ANNOUNCEMENT_CHANNEL_ID = "1511077202932924526";
const ADMIN_REGISTRATION_CHANNEL_ID = "1539321230652473404";

const S1N_INVITE = "https://discord.gg/invite/S1NS";

// 5 warnings = 10 minute timeout
const WARNINGS_BEFORE_TIMEOUT = 5;
const TIMEOUT_DURATION = 10 * 60 * 1000;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
    console.error("❌ TOKEN, CLIENT_ID or GUILD_ID is missing.");
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildModeration
    ]
});

// =====================================================
// FILE STORAGE
// =====================================================

const BIRTHDAY_FILE = path.join(__dirname, "birthdays.json");
const GIVEAWAY_FILE = path.join(__dirname, "giveaways.json");
const ADMIN_REGISTRATION_FILE = path.join(__dirname, "admin-registrations.json");
const LEVELS_FILE = path.join(__dirname, "levels.json");
const CONFIG_FILE = path.join(__dirname, "config.json");
const CREDITS_FILE = path.join(__dirname, "s1n-credits.json");

function loadJson(file, fallback) {
    try {
        if (!fs.existsSync(file)) {
            fs.writeFileSync(file, JSON.stringify(fallback, null, 4));
            return fallback;
        }

        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
        console.error(`Error loading ${file}:`, error);
        return fallback;
    }
}

function saveJson(file, data) {
    try {
        fs.writeFileSync(file, JSON.stringify(data, null, 4));
    } catch (error) {
        console.error(`Error saving ${file}:`, error);
    }
}

const s1nCredits = loadJson(CREDITS_FILE, {});
const webSessions = new Map();

function getCredits(userId) {
    const value = Number(s1nCredits[userId]);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function setCredits(userId, amount) {
    s1nCredits[userId] = Math.max(0, Math.floor(Number(amount) || 0));
    saveJson(CREDITS_FILE, s1nCredits);
    return s1nCredits[userId];
}

function addCredits(userId, amount) {
    return setCredits(userId, getCredits(userId) + Number(amount || 0));
}

const birthdays = new Map(
    Object.entries(loadJson(BIRTHDAY_FILE, {}))
);

const adminRegistrations = new Map(
    Object.entries(loadJson(ADMIN_REGISTRATION_FILE, {}))
);

const levels = new Map(
    Object.entries(loadJson(LEVELS_FILE, {}))
);

const giveaways = new Map(
    Object.entries(loadJson(GIVEAWAY_FILE, {}))
);

let botConfig = loadJson(CONFIG_FILE, {
    levelChannelId: null,
    maintenance: false,
    serverMute: false
});

// Make sure old config files get the new setting
if (typeof botConfig.serverMute !== "boolean") {
    botConfig.serverMute = false;
}

const warnings = new Map();

// =====================================================
// STAFF CHECK
// =====================================================

function isStaff(member) {
    if (!member) return false;

    return (
        member.permissions.has(
            PermissionsBitField.Flags.Administrator
        ) ||
        member.permissions.has(
            PermissionsBitField.Flags.ModerateMembers
        )
    );
}

// =====================================================
// WARNING SYSTEM
// =====================================================

async function addWarning(member, reason) {
    if (!member) return 0;

    const userId = member.id;

    let userWarnings =
        warnings.get(userId) || [];

    userWarnings.push({
        reason,
        timestamp: Date.now()
    });

    warnings.set(
        userId,
        userWarnings
    );

    const count = userWarnings.length;

    // Private DM
    try {
        const dmEmbed = new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle("⚠️ S1N GUILD WARNING")
            .setDescription(
                "Your message was removed because it violated the **S1N Guild rules**.\n\n" +
                `📌 **Reason:** ${reason}\n` +
                `⚠️ **Warnings:** ${count}/${WARNINGS_BEFORE_TIMEOUT}\n\n` +
                (
                    count >= WARNINGS_BEFORE_TIMEOUT
                        ? "🔇 You have reached the warning limit and have been timed out for **10 minutes**."
                        : `⚠️ Reaching **${WARNINGS_BEFORE_TIMEOUT} warnings** will result in a **10-minute timeout**.`
                )
            )
            .setFooter({
                text: "S1N Guild Moderation"
            })
            .setTimestamp();

        await member.send({
            embeds: [dmEmbed]
        });
    } catch {
        // User may have DMs disabled
    }

    // 5 warnings = 10-minute timeout
    if (count >= WARNINGS_BEFORE_TIMEOUT) {
        try {
            if (member.moderatable) {
                await member.timeout(
                    TIMEOUT_DURATION,
                    "S1N Guild: 5 warnings"
                );
            }
        } catch (error) {
            console.error(
                "Timeout error:",
                error
            );
        }
    }

    return count;
}

// =====================================================
// LEVELING SYSTEM
// =====================================================

const LEVEL_CHANNEL_ID = "1525542700399726774";

function processLeveling(userId) {
    let data = levels.get(userId) || {
        messages: 0,
        level: 0
    };

    const oldLevel = data.level;

    data.messages++;

    const newLevel = Math.floor(data.messages / 25);

    let leveledUp = false;

    if (newLevel > oldLevel) {
        data.level = newLevel;
        leveledUp = true;
    }

    levels.set(userId, data);

    saveJson(
        LEVELS_FILE,
        Object.fromEntries(levels)
    );

    return {
        leveledUp,
        oldLevel,
        newLevel,
        messages: data.messages
    };
}

// =====================================================
// DURATION
// =====================================================

function parseDuration(duration) {
    const match = duration
        .toLowerCase()
        .trim()
        .match(/^(\d+)\s*(s|m|h|d)$/);

    if (!match) return null;

    const amount =
        Number(match[1]);

    const unit =
        match[2];

    const multipliers = {
        s: 1000,
        m: 60 * 1000,
        h: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000
    };

    return amount * multipliers[unit];
}

// =====================================================
// SLASH COMMANDS
// =====================================================

const commands = [

    new SlashCommandBuilder()
        .setName("rules")
        .setDescription(
            "View the S1N Guild rules"
        ),

    new SlashCommandBuilder()
        .setName("help")
        .setDescription(
            "View S1N bot commands"
        ),

    new SlashCommandBuilder()
        .setName("invite")
        .setDescription(
            "Get the official S1N Discord invite"
        ),

    new SlashCommandBuilder()
        .setName("level")
        .setDescription(
            "Check your level"
        ),

    new SlashCommandBuilder()
        .setName("setup-level")
        .setDescription(
            "Set level-up notification channel"
        )
        .setDefaultMemberPermissions(
            PermissionsBitField.Flags.Administrator.toString()
        ),

    new SlashCommandBuilder()
        .setName("setup-ticket")
        .setDescription(
            "Create the SUPPORT ticket panel"
        )
        .setDefaultMemberPermissions(
            PermissionsBitField.Flags.Administrator.toString()
        ),

    new SlashCommandBuilder()
        .setName("setup-tournament")
        .setDescription(
            "Create the TOURNAMENT registration panel"
        )
        .setDefaultMemberPermissions(
            PermissionsBitField.Flags.Administrator.toString()
        ),

    new SlashCommandBuilder()
        .setName("setup-bday")
        .setDescription(
            "Create the birthday registration panel"
        )
        .setDefaultMemberPermissions(
            PermissionsBitField.Flags.Administrator.toString()
        ),

    new SlashCommandBuilder()
        .setName("setup-admin-register")
        .setDescription(
            "Create the staff application panel"
        )
        .setDefaultMemberPermissions(
            PermissionsBitField.Flags.Administrator.toString()
        ),

    new SlashCommandBuilder()
        .setName("setup-colors")
        .setDescription(
            "Create the username color panel"
        )
        .setDefaultMemberPermissions(
            PermissionsBitField.Flags.Administrator.toString()
        ),

    new SlashCommandBuilder()
        .setName("maintenance")
        .setDescription(
            "Control maintenance mode"
        )
        .setDefaultMemberPermissions(
            PermissionsBitField.Flags.Administrator.toString()
        )
        .addStringOption(option =>
            option
                .setName("status")
                .setDescription(
                    "Maintenance status"
                )
                .setRequired(true)
                .addChoices(
                    {
                        name: "On",
                        value: "on"
                    },
                    {
                        name: "Off",
                        value: "off"
                    }
                )
        ),

    new SlashCommandBuilder()
        .setName("mute")
        .setDescription(
            "OWNER ONLY: Mute or unmute the entire server"
        ),

    new SlashCommandBuilder()
        .setName("add-level")
        .setDescription(
            "OWNER ONLY: Add levels"
        )
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription(
                    "Target member"
                )
                .setRequired(true)
        )
        .addIntegerOption(option =>
            option
                .setName("amount")
                .setDescription(
                    "Amount of levels"
                )
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("announcement")
        .setDescription(
            "Create a beautiful S1N announcement"
        )
        .addStringOption(option =>
            option
                .setName("title")
                .setDescription(
                    "Announcement title"
                )
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("message")
                .setDescription(
                    "Separate lines with |"
                )
                .setRequired(true)
        )
        .addBooleanOption(option =>
            option
                .setName("ping")
                .setDescription(
                    "Ping @everyone"
                )
        ),

    new SlashCommandBuilder()
        .setName("giveaway-create")
        .setDescription(
            "Create a beautiful giveaway"
        )
        .addStringOption(option =>
            option
                .setName("prize")
                .setDescription(
                    "Giveaway prize"
                )
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName("duration")
                .setDescription(
                    "Example: 10m, 1h, 1d"
                )
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("giveaway-end")
        .setDescription(
            "End a giveaway"
        )
        .addStringOption(option =>
            option
                .setName("id")
                .setDescription(
                    "Giveaway ID"
                )
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("warnings")
        .setDescription(
            "Check warnings"
        )
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription(
                    "User"
                )
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("clear-warnings")
        .setDescription(
            "Clear warnings"
        )
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription(
                    "User"
                )
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("timeout")
        .setDescription(
            "Timeout a member"
        )
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription(
                    "User"
                )
                .setRequired(true)
        )
        .addIntegerOption(option =>
            option
                .setName("minutes")
                .setDescription(
                    "Minutes"
                )
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("gambles")
        .setDescription("Open S1N Gambles and check your SIN Credits"),

    new SlashCommandBuilder()
        .setName("kick")
        .setDescription(
            "Kick a member"
        )
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription(
                    "User"
                )
                .setRequired(true)
        )

].map(command =>
    command.toJSON()
);

// =====================================================
// MEMBER JOIN
// =====================================================

client.on(
    Events.GuildMemberAdd,
    async member => {

        const channel =
            member.guild.channels.cache.get(
                WELCOME_LEAVE_CHANNEL_ID
            );

        if (!channel) return;

        const embed =
            new EmbedBuilder()
                .setColor(0x57F287)
                .setTitle(
                    "👋 WELCOME TO S1N GUILD"
                )
                .setDescription(
                    `Welcome ${member}!\n\n` +
                    "⚔️ Welcome to **S1N Guild**!\n" +
                    "🔥 Get ready for Minecraft PvP, tournaments, giveaways and more.\n\n" +
                    `👥 **Members:** ${member.guild.memberCount}`
                )
                .setThumbnail(
                    member.user.displayAvatarURL()
                )
                .setFooter({
                    text:
                        "S1N Guild"
                })
                .setTimestamp();

        channel.send({
            embeds: [embed]
        }).catch(() => {});
    }
);

// =====================================================
// MEMBER LEAVE
// =====================================================

client.on(
    Events.GuildMemberRemove,
    async member => {

        const channel =
            member.guild.channels.cache.get(
                WELCOME_LEAVE_CHANNEL_ID
            );

        if (!channel) return;

        const embed =
            new EmbedBuilder()
                .setColor(0xED4245)
                .setTitle(
                    "🚪 MEMBER LEFT"
                )
                .setDescription(
                    `**${member.user.tag}** has left S1N Guild.`
                )
                .setThumbnail(
                    member.user.displayAvatarURL()
                )
                .setFooter({
                    text:
                        "S1N Guild"
                })
                .setTimestamp();

        channel.send({
            embeds: [embed]
        }).catch(() => {});
    }
);

// =====================================================
// MESSAGE CREATE
// =====================================================

client.on(
    Events.MessageCreate,
    async message => {

        if (
            message.author.bot ||
            !message.guild ||
            !message.member
        ) {
            return;
        }

        // =============================================
        // SERVER MUTE
        // OWNER IS THE ONLY PERSON WHO CAN TALK
        // =============================================

        const isOwner =
            message.author.id ===
            message.guild.ownerId;

        if (
            botConfig.serverMute &&
            !isOwner
        ) {

            await message.delete()
                .catch(() => {});

            return;
        }

        // =============================================
        // MAINTENANCE
        // =============================================

        if (
            botConfig.maintenance &&
            message.author.id !==
                message.guild.ownerId
        ) {

            if (
                !message.member.permissions.has(
                    PermissionsBitField.Flags.Administrator
                )
            ) {

                await message.delete()
                    .catch(() => {});

                const notice =
                    await message.channel.send({
                        content:
                            `⚠️ ${message.author} **S1N Guild is currently under maintenance.**`
                    }).catch(() => null);

                if (notice) {
                    setTimeout(() => {
                        notice.delete()
                            .catch(() => {});
                    }, 4000);
                }

                return;
            }
        }

        // =============================================
        // LEVELING
        // =============================================

        const levelData =
            processLeveling(
                message.author.id
            );

        if (
            levelData.leveledUp
        ) {

            const targetChannel =
                message.guild.channels.cache.get(
                    botConfig.levelChannelId
                ) ||
                message.channel;

            const levelEmbed =
                new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle(
                        "🎊 LEVEL UP!"
                    )
                    .setDescription(
                        `# ${levelData.oldLevel} ➜ ${levelData.newLevel}\n\n` +
                        `${message.author} has reached a new level!`
                    )
                    .setThumbnail(
                        message.author.displayAvatarURL()
                    )
                    .setFooter({
                        text:
                            "S1N Guild • Keep grinding!"
                    })
                    .setTimestamp();

            targetChannel.send({
                content:
                    `🎉 Well played, ${message.author}!`,
                embeds: [
                    levelEmbed
                ]
            }).catch(() => {});
        }
    }
);

// =====================================================
// INTERACTIONS
// =====================================================

client.on(
    Events.InteractionCreate,
    async interaction => {

        try {

            // =================================================
            // SLASH COMMANDS
            // =================================================

            if (
                interaction.isChatInputCommand()
            ) {

                const {
                    commandName,
                    options,
                    guild,
                    user,
                    member,
                    channel
                } = interaction;

                if (commandName === "gambles") {
                    const websiteUrl = `${S1N_WEBSITE_URL}/`;
                    const credits = getCredits(user.id);
                    const oauthUrl = DISCORD_CLIENT_SECRET && DISCORD_OAUTH_REDIRECT_URI
                        ? `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(CLIENT_ID)}&response_type=code&redirect_uri=${encodeURIComponent(DISCORD_OAUTH_REDIRECT_URI)}&scope=identify`
                        : websiteUrl;

                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setLabel("🎰 Open S1N Gambles").setStyle(ButtonStyle.Link).setURL(websiteUrl),
                        new ButtonBuilder().setLabel("🔗 Connect Discord").setStyle(ButtonStyle.Link).setURL(oauthUrl)
                    );

                    const embed = new EmbedBuilder()
                        .setColor(0x9147ff)
                        .setTitle("🎰 S1N GAMBLES")
                        .setDescription(`Your current **SIN Credits** balance is **${credits.toLocaleString()}**.\n\nConnect your Discord account on the website to use the same balance there.`)
                        .setFooter({ text: "S1N Gambles • Virtual Credits" })
                        .setTimestamp();

                    return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
                }

                // =============================================
                // RULES
                // =============================================

                if (
                    commandName ===
                    "rules"
                ) {

                    const embed =
                        new EmbedBuilder()
                            .setColor(0x2b2d31)
                            .setTitle(
                                "📜 S1N GUILD RULES"
                            )
                            .setDescription(
                                "⚠️ **Please read all rules carefully.**\n\n" +

                                "🇬🇧 **ENGLISH RULES**\n\n" +

                                "1️⃣ **Respect Everyone**\n" +
                                "• No harassment or serious insults.\n" +
                                "• Respect members and staff.\n\n" +

                                "2️⃣ **Chat Rules**\n" +
                                "• No spam.\n" +
                                "• No excessive caps.\n" +
                                "• No inappropriate or 18+ content.\n\n" +

                                "3️⃣ **Advertising**\n" +
                                "• No advertising without permission.\n\n" +

                                "4️⃣ **Punishments**\n" +
                                "• Breaking the rules may result in warnings, timeout, kick or ban.\n\n" +

                                "🎫 **SUPPORT**\n" +
                                "If you have an issue, use the ticket system instead of causing drama in public channels.\n\n" +

                                "📜 **DISCORD GUIDELINES**\n" +
                                "[Discord Terms of Service](https://discord.com/terms)\n" +
                                "[Discord Community Guidelines](https://discord.com/guidelines)"
                            )
                            .setFooter({
                                text:
                                    "S1N Guild • Stay respectful."
                            })
                            .setTimestamp();

                    return interaction.reply({
                        embeds: [embed]
                    });
                }

                // =============================================
                // HELP
                // =============================================

                if (
                    commandName ===
                    "help"
                ) {

                    const embed =
                        new EmbedBuilder()
                            .setColor(0x2b2d31)
                            .setTitle(
                                "⚔️ S1N GUILD BOT"
                            )
                            .setDescription(
                                "━━━━━━━━━━━━━━━━━━━━\n\n" +
                                "📜 `/rules` — View rules\n" +
                                "🔗 `/invite` — Official invite\n" +
                                "📊 `/level` — Check level\n" +
                                "🔇 `/mute` — Owner-only server mute\n\n" +

                                "🎫 `/setup-ticket` — Support panel\n" +
                                "🏆 `/setup-tournament` — Tournament panel\n" +
                                "🎂 `/setup-bday` — Birthday panel\n" +
                                "🎨 `/setup-colors` — Color panel\n" +
                                "🛡️ `/setup-admin-register` — Staff panel\n\n" +

                                "🎉 `/giveaway-create` — Create giveaway\n" +
                                "🏁 `/giveaway-end` — End giveaway\n" +
                                "📢 `/announcement` — Announcement\n\n" +

                                "⚠️ `/warnings` — Check warnings\n" +
                                "🔨 `/timeout` — Timeout member\n" +
                                "👢 `/kick` — Kick member\n\n" +
                                "━━━━━━━━━━━━━━━━━━━━"
                            )
                            .setFooter({
                                text:
                                    "S1N Guild"
                            })
                            .setTimestamp();

                    return interaction.reply({
                        embeds: [embed]
                    });
                }

                // =============================================
                // INVITE
                // =============================================

                if (
                    commandName ===
                    "invite"
                ) {

                    const embed =
                        new EmbedBuilder()
                            .setColor(0x2b2d31)
                            .setAuthor({
                                name:
                                    "S1N GUILD"
                            })
                            .setTitle(
                                "⚔️ JOIN S1N GUILD"
                            )
                            .setDescription(
                                "━━━━━━━━━━━━━━━━━━━━\n\n" +
                                "🔥 **WELCOME TO S1N**\n\n" +
                                "A Minecraft PvP guild for competitive players.\n\n" +

                                "⚔️ **BedWars**\n" +
                                "☁️ **SkyPvP**\n" +
                                "🏆 **Tournaments**\n" +
                                "🎁 **Giveaways**\n" +
                                "💎 **Special Ranks**\n\n" +

                                "━━━━━━━━━━━━━━━━━━━━\n\n" +
                                "**CLICK BELOW TO JOIN**"
                            )
                            .setThumbnail(
                                guild.iconURL() ||
                                null
                            )
                            .setFooter({
                                text:
                                    "S1N • Minecraft PvP Guild"
                            })
                            .setTimestamp();

                    const row =
                        new ActionRowBuilder()
                            .addComponents(
                                new ButtonBuilder()
                                    .setLabel(
                                        "JOIN S1N GUILD"
                                    )
                                    .setEmoji("⚔️")
                                    .setStyle(
                                        ButtonStyle.Link
                                    )
                                    .setURL(
                                        S1N_INVITE
                                    )
                            );

                    return interaction.reply({
                        embeds: [embed],
                        components: [row]
                    });
                }

                // =============================================
                // MAINTENANCE
                // =============================================

                if (
                    commandName ===
                    "maintenance"
                ) {

                    const status =
                        options.getString(
                            "status"
                        );

                    botConfig.maintenance =
                        status === "on";

                    saveJson(
                        CONFIG_FILE,
                        botConfig
                    );

                    return interaction.reply({
                        content:
                            status === "on"
                                ? "🚨 **MAINTENANCE MODE ENABLED**"
                                : "✅ **MAINTENANCE MODE DISABLED**",
                        ephemeral: true
                    });
                }

                // =============================================
                // SERVER MUTE
                // OWNER ONLY
                // =============================================

                if (
                    commandName ===
                    "mute"
                ) {

                    if (
                        user.id !==
                        guild.ownerId
                    ) {
                        return interaction.reply({
                            content:
                                "❌ **Owner only.** Only the server owner can use `/mute`.",
                            ephemeral: true
                        });
                    }

                    botConfig.serverMute =
                        !botConfig.serverMute;

                    saveJson(
                        CONFIG_FILE,
                        botConfig
                    );

                    // Update channel permissions
                    try {

                        for (
                            const serverChannel
                            of guild.channels.cache.values()
                        ) {

                            if (
                                !serverChannel.isTextBased() ||
                                !serverChannel.permissionOverwrites
                            ) {
                                continue;
                            }

                            if (
                                botConfig.serverMute
                            ) {

                                await serverChannel.permissionOverwrites.edit(
                                    guild.roles.everyone,
                                    {
                                        SendMessages: false
                                    },
                                    {
                                        reason:
                                            "S1N Server Mute Enabled"
                                    }
                                ).catch(() => {});

                            } else {

                                await serverChannel.permissionOverwrites.edit(
                                    guild.roles.everyone,
                                    {
                                        SendMessages: null
                                    },
                                    {
                                        reason:
                                            "S1N Server Mute Disabled"
                                    }
                                ).catch(() => {});
                            }
                        }

                    } catch (error) {

                        console.error(
                            "Server mute permission update error:",
                            error
                        );
                    }

                    return interaction.reply({
                        content:
                            botConfig.serverMute
                                ? "🔇 **SERVER MUTED**\n\nEveryone in the server is now muted. Only the **server owner** can talk."
                                : "🔊 **SERVER UNMUTED**\n\nServer chat has been restored.",
                        ephemeral: true
                    });
                }

                // =============================================
                // LEVEL SETUP
                // =============================================

                if (
                    commandName ===
                    "setup-level"
                ) {

                    botConfig.levelChannelId =
                        channel.id;

                    saveJson(
                        CONFIG_FILE,
                        botConfig
                    );

                    return interaction.reply({
                        content:
                            "✅ Level-up notifications will now be sent here.",
                        ephemeral: true
                    });
                }

                // =============================================
                // LEVEL
                // =============================================

                if (
                    commandName ===
                    "level"
                ) {

                    const data =
                        levels.get(
                            user.id
                        ) || {
                            messages: 0,
                            level: 0
                        };

                    return interaction.reply({
                        embeds: [
                            new EmbedBuilder()
                                .setColor(0x5865F2)
                                .setTitle(
                                    "📊 YOUR S1N LEVEL"
                                )
                                .setDescription(
                                    `👤 **User:** ${user}\n\n` +
                                    `🏆 **Level:** ${data.level}\n` +
                                    `💬 **Messages:** ${data.messages}\n\n` +
                                    `📈 **Next level:** ${25 - (data.messages % 25)} messages`
                                )
                                .setThumbnail(
                                    user.displayAvatarURL()
                                )
                        ]
                    });
                }

                // =============================================
                // ADD LEVEL
                // =============================================

                if (
                    commandName ===
                    "add-level"
                ) {

                    if (
                        user.id !==
                        guild.ownerId
                    ) {
                        return interaction.reply({
                            content:
                                "❌ Owner only.",
                            ephemeral: true
                        });
                    }

                    const target =
                        options.getUser(
                            "user"
                        );

                    const amount =
                        options.getInteger(
                            "amount"
                        );

                    let data =
                        levels.get(
                            target.id
                        ) || {
                            messages: 0,
                            level: 0
                        };

                    data.level += amount;
                    data.messages =
                        data.level * 25;

                    levels.set(
                        target.id,
                        data
                    );

                    saveJson(
                        LEVELS_FILE,
                        Object.fromEntries(
                            levels
                        )
                    );

                    return interaction.reply({
                        content:
                            `✅ Added **${amount} levels** to ${target}.`
                    });
                }

                // =============================================
                // SUPPORT TICKET SETUP
                // =============================================

                if (
                    commandName ===
                    "setup-ticket"
                ) {

                    const embed =
                        new EmbedBuilder()
                            .setColor(0x2b2d31)
                            .setTitle(
                                "🎫 S1N SUPPORT CENTER"
                            )
                            .setDescription(
                                "━━━━━━━━━━━━━━━━━━━━━━━━\n\n" +
                                "# NEED HELP?\n\n" +
                                "Open a private support ticket and our staff team will help you.\n\n" +

                                "📌 **SUPPORT TICKET**\n" +
                                "Use this for:\n" +
                                "• Server issues\n" +
                                "• Player reports\n" +
                                "• Questions\n" +
                                "• General support\n\n" +

                                "⚠️ Please explain your issue clearly.\n" +
                                "⚠️ Do not create unnecessary tickets.\n\n" +

                                "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
                                "**S1N SUPPORT • STAFF ASSISTANCE**"
                            )
                            .setFooter({
                                text:
                                    "S1N Guild • Support"
                            })
                            .setTimestamp();

                    const row =
                        new ActionRowBuilder()
                            .addComponents(
                                new ButtonBuilder()
                                    .setCustomId(
                                        "open_support_ticket"
                                    )
                                    .setLabel(
                                        "OPEN SUPPORT TICKET"
                                    )
                                    .setEmoji("🎫")
                                    .setStyle(
                                        ButtonStyle.Primary
                                    )
                            );

                    await channel.send({
                        embeds: [embed],
                        components: [row]
                    });

                    return interaction.reply({
                        content:
                            "✅ Support ticket panel created.",
                        ephemeral: true
                    });
                }

                // =============================================
                // TOURNAMENT SETUP
                // =============================================

                if (
                    commandName ===
                    "setup-tournament"
                ) {

                    const embed =
                        new EmbedBuilder()
                            .setColor(0x2b2d31)
                            .setTitle(
                                "🏆 S1N TOURNAMENTS"
                            )
                            .setDescription(
                                "━━━━━━━━━━━━━━━━━━━━━━━━\n\n" +
                                "# ⚔️ TOURNAMENT REGISTRATION\n\n" +
                                "Ready to compete against the best?\n\n" +

                                "🏆 **S1N tournaments** may include:\n" +
                                "⚔️ BedWars\n" +
                                "☁️ SkyPvP\n" +
                                "🔥 PvP Events\n" +
                                "🥇 Special competitions\n\n" +

                                "📋 Click **REGISTER TOURNAMENT** below to register.\n\n" +
                                "🛡️ Staff will provide the tournament details and rules after registration.\n\n" +

                                "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
                                "**GOOD LUCK, WARRIORS!** ⚔️"
                            )
                            .setFooter({
                                text:
                                    "S1N Guild • Tournament System"
                            })
                            .setTimestamp();

                    const row =
                        new ActionRowBuilder()
                            .addComponents(
                                new ButtonBuilder()
                                    .setCustomId(
                                        "tournament_register"
                                    )
                                    .setLabel(
                                        "REGISTER TOURNAMENT"
                                    )
                                    .setEmoji("🏆")
                                    .setStyle(
                                        ButtonStyle.Success
                                    )
                            );

                    await channel.send({
                        embeds: [embed],
                        components: [row]
                    });

                    return interaction.reply({
                        content:
                            "✅ Tournament registration panel created.",
                        ephemeral: true
                    });
                }

                // =============================================
                // BIRTHDAY SETUP
                // =============================================

                if (
                    commandName ===
                    "setup-bday"
                ) {

                    const embed =
                        new EmbedBuilder()
                            .setColor(0x2b2d31)
                            .setTitle(
                                "🎂 S1N BIRTHDAY REGISTRATION"
                            )
                            .setDescription(
                                "━━━━━━━━━━━━━━━━━━━━━━━━\n\n" +
                                "# 🎉 CELEBRATE WITH S1N\n\n" +
                                "Want S1N Guild to celebrate your birthday?\n\n" +

                                "Click the button below and enter:\n\n" +
                                "👤 **Your Name**\n" +
                                "⛏️ **Minecraft IGN**\n" +
                                "📅 **Birthday Month**\n" +
                                "🗓️ **Birthday Day**\n\n" +

                                "🎂 Your birthday will be posted in the official birthday channel.\n" +
                                "📩 On your birthday, S1N Bot will also send you a private birthday DM.\n\n" +

                                "━━━━━━━━━━━━━━━━━━━━━━━━"
                            )
                            .setFooter({
                                text:
                                    "S1N Guild • Birthday System"
                            })
                            .setTimestamp();

                    const row =
                        new ActionRowBuilder()
                            .addComponents(
                                new ButtonBuilder()
                                    .setCustomId(
                                        "birthday_register"
                                    )
                                    .setLabel(
                                        "REGISTER BIRTHDAY"
                                    )
                                    .setEmoji("🎂")
                                    .setStyle(
                                        ButtonStyle.Primary
                                    )
                            );

                    await channel.send({
                        embeds: [embed],
                        components: [row]
                    });

                    return interaction.reply({
                        content:
                            "✅ Birthday panel created.",
                        ephemeral: true
                    });
                }

                // =============================================
                // ADMIN REGISTRATION SETUP
                // =============================================

                if (
                    commandName ===
                    "setup-admin-register"
                ) {

                    const embed =
                        new EmbedBuilder()
                            .setColor(0x2b2d31)
                            .setTitle(
                                "🛡️ S1N STAFF APPLICATION"
                            )
                            .setDescription(
                                "━━━━━━━━━━━━━━━━━━━━━━━━\n\n" +
                                "# ⚔️ WANT TO JOIN S1N STAFF?\n\n" +
                                "Think you have what it takes to become part of the S1N staff team?\n\n" +

                                "📋 **APPLICATION REQUIREMENTS**\n" +
                                "• You must be a member of S1N Guild.\n" +
                                "• We check your time in the guild.\n" +
                                "• You should have good behavior.\n" +
                                "• Applications are reviewed by staff.\n\n" +

                                "📝 Your application will ask for:\n" +
                                "⛏️ Minecraft IGN\n" +
                                "🛡️ Previous staff/admin experience\n" +
                                "💭 Why should we choose you?\n\n" +

                                "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
                                "**GOOD LUCK WITH YOUR APPLICATION!**"
                            )
                            .setFooter({
                                text:
                                    "S1N Guild • Staff Applications"
                            })
                            .setTimestamp();

                    const row =
                        new ActionRowBuilder()
                            .addComponents(
                                new ButtonBuilder()
                                    .setCustomId(
                                        "admin_register"
                                    )
                                    .setLabel(
                                        "APPLY FOR STAFF"
                                    )
                                    .setEmoji("🛡️")
                                    .setStyle(
                                        ButtonStyle.Primary
                                    )
                            );

                    await channel.send({
                        embeds: [embed],
                        components: [row]
                    });

                    return interaction.reply({
                        content:
                            "✅ Staff application panel created.",
                        ephemeral: true
                    });
                }

                // =============================================
                // COLORS
                // =============================================

                if (
                    commandName ===
                    "setup-colors"
                ) {

                    const embed =
                        new EmbedBuilder()
                            .setColor(0x2b2d31)
                            .setTitle(
                                "🎨 S1N USERNAME COLORS"
                            )
                            .setDescription(
                                "━━━━━━━━━━━━━━━━━━━━━━━━\n\n" +
                                "# CHOOSE YOUR COLOR\n\n" +
                                "Select a color below to change your username color.\n\n" +
                                "🔴 Red\n" +
                                "🟠 Orange\n" +
                                "🟡 Yellow\n" +
                                "🟢 Green\n" +
                                "🔵 Blue\n" +
                                "🟣 Purple\n" +
                                "🩷 Pink\n" +
                                "⚪ White\n\n" +
                                "━━━━━━━━━━━━━━━━━━━━━━━━"
                            )
                            .setFooter({
                                text:
                                    "S1N Guild • Color Roles"
                            })
                            .setTimestamp();

                    const menu =
                        new StringSelectMenuBuilder()
                            .setCustomId(
                                "color_select"
                            )
                            .setPlaceholder(
                                "🎨 Select your color"
                            )
                            .addOptions(
                                {
                                    label: "Red",
                                    value: "red",
                                    emoji: "🔴"
                                },
                                {
                                    label: "Orange",
                                    value: "orange",
                                    emoji: "🟠"
                                },
                                {
                                    label: "Yellow",
                                    value: "yellow",
                                    emoji: "🟡"
                                },
                                {
                                    label: "Green",
                                    value: "green",
                                    emoji: "🟢"
                                },
                                {
                                    label: "Blue",
                                    value: "blue",
                                    emoji: "🔵"
                                },
                                {
                                    label: "Purple",
                                    value: "purple",
                                    emoji: "🟣"
                                },
                                {
                                    label: "Pink",
                                    value: "pink",
                                    emoji: "🩷"
                                },
                                {
                                    label: "White",
                                    value: "white",
                                    emoji: "⚪"
                                }
                            );

                    await channel.send({
                        embeds: [embed],
                        components: [
                            new ActionRowBuilder()
                                .addComponents(menu)
                        ]
                    });

                    return interaction.reply({
                        content:
                            "✅ Color panel created.",
                        ephemeral: true
                    });
                }

                // =============================================
                // ANNOUNCEMENT
                // =============================================

                if (
                    commandName ===
                    "announcement"
                ) {

                    if (
                        !isStaff(member)
                    ) {
                        return interaction.reply({
                            content:
                                "❌ No permission.",
                            ephemeral: true
                        });
                    }

                    const title =
                        options
                            .getString("title")
                            .trim();

                    const rawMessage =
                        options.getString("message");

                    const lines =
                        rawMessage
                            .split("|")
                            .map(line => line.trim())
                            .filter(Boolean);

                    const description =
                        lines
                            .map(line => `**${line}**`)
                            .join("\n\n");

                    const embed =
                        new EmbedBuilder()
                            .setColor(0x5865F2)

                            .setAuthor({
                                name: "S1N GUILD",
                                iconURL:
                                    guild.iconURL({
                                        extension: "png",
                                        size: 128
                                    }) || undefined
                            })

                            .setTitle(
                                `📢 ${title}`
                            )

                            .setDescription(
                                description
                            )

                            .setThumbnail(
                                guild.iconURL({
                                    extension: "png",
                                    size: 256
                                }) || null
                            )

                            .setFooter({
                                text:
                                    `S1N Guild • Published by ${user.username}`,
                                iconURL:
                                    client.user.displayAvatarURL({
                                        extension: "png",
                                        size: 64
                                    })
                            })

                            .setTimestamp();

                    const shouldPing =
                        options.getBoolean("ping") ?? true;

                    await channel.send({
                        content:
                            shouldPing
                                ? "@everyone"
                                : undefined,

                        embeds: [embed],

                        allowedMentions:
                            shouldPing
                                ? {
                                    parse: ["everyone"]
                                }
                                : {
                                    parse: []
                                }
                    });

                    return interaction.reply({
                        content:
                            "✅ Announcement broadcasted.",
                        ephemeral: true
                    });
                }

                // =============================================
                // GIVEAWAY CREATE
                // =============================================

                if (
                    commandName ===
                    "giveaway-create"
                ) {

                    if (
                        !isStaff(member)
                    ) {
                        return interaction.reply({
                            content:
                                "❌ No permission.",
                            ephemeral: true
                        });
                    }

                    const prize =
                        options.getString(
                            "prize"
                        );

                    const duration =
                        options.getString(
                            "duration"
                        );

                    const durationMs =
                        parseDuration(
                            duration
                        );

                    if (!durationMs) {
                        return interaction.reply({
                            content:
                                "❌ Invalid duration. Example: `10m`, `1h`, `1d`.",
                            ephemeral: true
                        });
                    }

                    const id =
                        Math.random()
                            .toString(36)
                            .substring(2, 8)
                            .toUpperCase();

                    const endTime =
                        Date.now() +
                        durationMs;

                    const embed =
                        new EmbedBuilder()
                            .setColor(
                                0x2b2d31
                            )
                            .setAuthor({
                                name:
                                    "S1N GUILD GIVEAWAYS",
                                iconURL:
                                    guild.iconURL() ||
                                    undefined
                            })
                            .setTitle(
                                "🎉 ✦ S1N GIVEAWAY ✦ 🎉"
                            )
                            .setDescription(
                                "━━━━━━━━━━━━━━━━━━━━━━━━\n\n" +
                                "# 🎁 GIVEAWAY\n\n" +
                                `## ${prize}\n\n` +

                                "🔥 **HOW TO ENTER**\n" +
                                "Click the button below to enter.\n\n" +

                                "🎉 One click = one entry.\n" +
                                "🏆 One winner will be selected.\n" +
                                "🍀 Good luck everyone!\n\n" +

                                `⏰ **ENDS:** <t:${Math.floor(endTime / 1000)}:R>\n` +
                                `🆔 **ID:** \`${id}\`\n\n` +

                                "━━━━━━━━━━━━━━━━━━━━━━━━"
                            )
                            .setThumbnail(
                                guild.iconURL() ||
                                null
                            )
                            .setFooter({
                                text:
                                    "S1N • Good luck!"
                            })
                            .setTimestamp();

                    const row =
                        new ActionRowBuilder()
                            .addComponents(
                                new ButtonBuilder()
                                    .setCustomId(
                                        `giveaway_enter_${id}`
                                    )
                                    .setLabel(
                                        "ENTER GIVEAWAY"
                                    )
                                    .setEmoji("🎉")
                                    .setStyle(
                                        ButtonStyle.Success
                                    )
                            );

                    const msg =
                        await channel.send({
                            content:
                                "🎉 **A NEW S1N GIVEAWAY HAS STARTED!**",
                            embeds: [embed],
                            components: [row]
                        });

                    giveaways.set(
                        id,
                        {
                            prize,
                            msgId: msg.id,
                            channelId:
                                channel.id,
                            participants: [],
                            endTime
                        }
                    );

                    saveJson(
                        GIVEAWAY_FILE,
                        Object.fromEntries(giveaways)
                    );

                    setTimeout(
                        async () => {
                            await endGiveaway(
                                id,
                                guild
                            );
                        },
                        durationMs
                    );

                    return interaction.reply({
                        content:
                            `✅ Giveaway **${id}** started.`,
                        ephemeral: true
                    });
                }

                // =============================================
                // GIVEAWAY END
                // =============================================

                if (
                    commandName ===
                    "giveaway-end"
                ) {

                    if (
                        !isStaff(member)
                    ) {
                        return interaction.reply({
                            content:
                                "❌ No permission.",
                            ephemeral: true
                        });
                    }

                    const id =
                        options.getString(
                            "id"
                        ).toUpperCase();

                    const result =
                        await endGiveaway(
                            id,
                            guild
                        );

                    return interaction.reply({
                        content:
                            result
                                ? "🏆 Giveaway ended."
                                : "❌ Giveaway not found.",
                        ephemeral: true
                    });
                }

                // =============================================
                // WARNINGS
                // =============================================

                if (
                    commandName ===
                    "warnings"
                ) {

                    if (
                        !isStaff(member)
                    ) {
                        return interaction.reply({
                            content:
                                "❌ No permission.",
                            ephemeral: true
                        });
                    }

                    const target =
                        options.getUser(
                            "user"
                        );

                    const userWarnings =
                        warnings.get(
                            target.id
                        ) || [];

                    const list =
                        userWarnings.length
                            ? userWarnings
                                .map(
                                    (w, i) =>
                                        `**${i + 1}.** ${w.reason}`
                                )
                                .join("\n")
                            : "✅ No warnings.";

                    return interaction.reply({
                        embeds: [
                            new EmbedBuilder()
                                .setColor(
                                    userWarnings.length
                                        ? 0xED4245
                                        : 0x57F287
                                )
                                .setTitle(
                                    `⚠️ WARNINGS — ${target.username}`
                                )
                                .setDescription(
                                    list
                                )
                                .setFooter({
                                    text:
                                        `Total: ${userWarnings.length}/${WARNINGS_BEFORE_TIMEOUT}`
                                })
                        ]
                    });
                }

                // =============================================
                // CLEAR WARNINGS
                // =============================================

                if (
                    commandName ===
                    "clear-warnings"
                ) {

                    if (
                        !isStaff(member)
                    ) {
                        return interaction.reply({
                            content:
                                "❌ No permission.",
                            ephemeral: true
                        });
                    }

                    const target =
                        options.getUser(
                            "user"
                        );

                    warnings.delete(
                        target.id
                    );

                    return interaction.reply({
                        content:
                            `✅ Cleared warnings for ${target}.`
                    });
                }

                // =============================================
                // TIMEOUT
                // =============================================

                if (
                    commandName ===
                    "timeout"
                ) {

                    if (
                        !isStaff(member)
                    ) {
                        return interaction.reply({
                            content:
                                "❌ No permission.",
                            ephemeral: true
                        });
                    }

                    const target =
                        options.getMember(
                            "user"
                        );

                    const minutes =
                        options.getInteger(
                            "minutes"
                        );

                    if (!target) {
                        return interaction.reply({
                            content:
                                "❌ Member not found.",
                            ephemeral: true
                        });
                    }

                    try {

                        await target.timeout(
                            minutes * 60 * 1000,
                            "S1N Staff Timeout"
                        );

                        return interaction.reply({
                            content:
                                `🔇 ${target} has been timed out for **${minutes} minutes**.`
                        });

                    } catch {

                        return interaction.reply({
                            content:
                                "❌ I cannot timeout this member.",
                            ephemeral: true
                        });
                    }
                }

                // =============================================
                // KICK
                // =============================================

                if (
                    commandName ===
                    "kick"
                ) {

                    if (
                        !isStaff(member)
                    ) {
                        return interaction.reply({
                            content:
                                "❌ No permission.",
                            ephemeral: true
                        });
                    }

                    const target =
                        options.getMember(
                            "user"
                        );

                    if (!target) {
                        return interaction.reply({
                            content:
                                "❌ Member not found.",
                            ephemeral: true
                        });
                    }

                    try {

                        await target.kick(
                            "S1N Staff Kick"
                        );

                        return interaction.reply({
                            content:
                                `👢 ${target.user.tag} has been kicked.`
                        });

                    } catch {

                        return interaction.reply({
                            content:
                                "❌ I cannot kick this member.",
                            ephemeral: true
                        });
                    }
                }
            }

            // =================================================
            // BUTTONS
            // =================================================

            if (
                interaction.isButton()
            ) {

                // =============================================
                // ADMIN APPLICATION ACCEPT / DECLINE
                // =============================================

                if (
                    interaction.customId.startsWith(
                        "admin_accept_"
                    ) ||
                    interaction.customId.startsWith(
                        "admin_decline_"
                    )
                ) {

                    if (
                        !isStaff(
                            interaction.member
                        )
                    ) {
                        return interaction.reply({
                            content:
                                "❌ You do not have permission to review staff applications.",
                            ephemeral: true
                        });
                    }

                    const isAccept =
                        interaction.customId.startsWith(
                            "admin_accept_"
                        );

                    const applicantId =
                        interaction.customId
                            .replace(
                                isAccept
                                    ? "admin_accept_"
                                    : "admin_decline_",
                                ""
                            );

                    const registration =
                        adminRegistrations.get(
                            applicantId
                        );

                    if (!registration) {
                        return interaction.reply({
                            content:
                                "❌ This application could not be found.",
                            ephemeral: true
                        });
                    }

                    if (
                        registration.status !==
                        "pending"
                    ) {
                        return interaction.reply({
                            content:
                                `⚠️ This application has already been **${registration.status}**.`,
                            ephemeral: true
                        });
                    }

                    registration.status =
                        isAccept
                            ? "accepted"
                            : "declined";

                    registration.reviewedBy =
                        interaction.user.id;

                    registration.reviewedByTag =
                        interaction.user.tag;

                    registration.reviewedAt =
                        Date.now();

                    adminRegistrations.set(
                        applicantId,
                        registration
                    );

                    saveJson(
                        ADMIN_REGISTRATION_FILE,
                        Object.fromEntries(
                            adminRegistrations
                        )
                    );

                    const updatedEmbed =
                        EmbedBuilder.from(
                            interaction.message.embeds[0]
                        )
                            .setColor(
                                isAccept
                                    ? 0x57F287
                                    : 0xED4245
                            )
                            .setDescription(
                                "━━━━━━━━━━━━━━━━━━━━━━━━\n\n" +
                                `👤 **Applicant:** <@${registration.userId}>\n\n` +
                                `⛏️ **Minecraft IGN:** ${registration.ign}\n\n` +
                                `🛡️ **Previous Admin/Staff Experience:**\n${registration.previous}\n\n` +
                                `💭 **Why should we choose you?**\n${registration.reason}\n\n` +
                                `📅 **Joined S1N:** <t:${Math.floor(registration.joinedAt / 1000)}:R>\n\n` +
                                "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
                                `${isAccept ? "✅ **STATUS:** ACCEPTED" : "❌ **STATUS:** DECLINED"}\n` +
                                `👮 **Reviewed by:** ${interaction.user}`
                            )
                            .setTimestamp();

                    await interaction.message.edit({
                        embeds: [
                            updatedEmbed
                        ],
                        components: []
                    });

                    try {

                        const applicant =
                            await interaction.guild.members.fetch(
                                applicantId
                            );

                        const dmEmbed =
                            new EmbedBuilder()
                                .setColor(
                                    isAccept
                                        ? 0x57F287
                                        : 0xED4245
                                )
                                .setTitle(
                                    isAccept
                                        ? "✅ S1N STAFF APPLICATION ACCEPTED"
                                        : "❌ S1N STAFF APPLICATION DECLINED"
                                )
                                .setDescription(
                                    isAccept
                                        ? "🎉 Congratulations!\n\n" +
                                          "Your **S1N Staff Application** has been accepted by the staff team.\n\n" +
                                          `👮 **Reviewed by:** ${interaction.user}\n\n` +
                                          "A staff member will contact you regarding the next steps."
                                        : "Your **S1N Staff Application** has been declined.\n\n" +
                                          `👮 **Reviewed by:** ${interaction.user}\n\n` +
                                          "Thank you for applying to join the S1N staff team."
                                )
                                .setFooter({
                                    text:
                                        "S1N Guild • Staff Applications"
                                })
                                .setTimestamp();

                        await applicant.send({
                            embeds: [
                                dmEmbed
                            ]
                        });

                    } catch {}

                    return interaction.reply({
                        content:
                            isAccept
                                ? `✅ Staff application from <@${applicantId}> has been **ACCEPTED**.`
                                : `❌ Staff application from <@${applicantId}> has been **DECLINED**.`,
                        ephemeral: true
                    });
                }

                // =============================================
                // SUPPORT TICKET
                // =============================================

                if (
                    interaction.customId ===
                    "open_support_ticket"
                ) {

                    const existing =
                        interaction.guild.channels.cache.find(
                            c =>
                                c.type ===
                                    ChannelType.GuildText &&
                                c.topic ===
                                    `S1N_SUPPORT_${interaction.user.id}`
                        );

                    if (existing) {
                        return interaction.reply({
                            content:
                                `⚠️ You already have a support ticket: ${existing}`,
                            ephemeral: true
                        });
                    }

                    const ticket =
                        await interaction.guild.channels.create({
                            name:
                                `support-${interaction.user.username}`.toLowerCase(),
                            type:
                                ChannelType.GuildText,
                            topic:
                                `S1N_SUPPORT_${interaction.user.id}`,
                            permissionOverwrites: [
                                {
                                    id:
                                        interaction.guild.roles.everyone.id,
                                    deny: [
                                        PermissionsBitField.Flags.ViewChannel
                                    ]
                                },
                                {
                                    id:
                                        interaction.user.id,
                                    allow: [
                                        PermissionsBitField.Flags.ViewChannel,
                                        PermissionsBitField.Flags.SendMessages,
                                        PermissionsBitField.Flags.ReadMessageHistory
                                    ]
                                }
                            ]
                        });

                    const embed =
                        new EmbedBuilder()
                            .setColor(0x2b2d31)
                            .setTitle(
                                "🎫 S1N SUPPORT TICKET"
                            )
                            .setDescription(
                                "━━━━━━━━━━━━━━━━━━━━━━━━\n\n" +
                                `Welcome ${interaction.user}!\n\n` +
                                "🛡️ **A staff member will assist you.**\n\n" +
                                "Please explain your issue clearly and wait for staff.\n\n" +
                                "━━━━━━━━━━━━━━━━━━━━━━━━"
                            )
                            .setFooter({
                                text:
                                    "S1N Support"
                            })
                            .setTimestamp();

                    const row =
                        new ActionRowBuilder()
                            .addComponents(
                                new ButtonBuilder()
                                    .setCustomId(
                                        "close_ticket"
                                    )
                                    .setLabel(
                                        "CLOSE TICKET"
                                    )
                                    .setEmoji("🔒")
                                    .setStyle(
                                        ButtonStyle.Danger
                                    )
                            );

                    await ticket.send({
                        content:
                            `${interaction.user}`,
                        embeds: [embed],
                        components: [row]
                    });

                    return interaction.reply({
                        content:
                            `✅ Support ticket created: ${ticket}`,
                        ephemeral: true
                    });
                }

                // =============================================
                // TOURNAMENT REGISTER
                // =============================================

                if (
                    interaction.customId ===
                    "tournament_register"
                ) {

                    const modal =
                        new ModalBuilder()
                            .setCustomId(
                                "tournament_modal"
                            )
                            .setTitle(
                                "🏆 S1N Tournament Registration"
                            );

                    const ign =
                        new TextInputBuilder()
                            .setCustomId(
                                "tournament_ign"
                            )
                            .setLabel(
                                "Minecraft IGN"
                            )
                            .setPlaceholder(
                                "Your Minecraft username"
                            )
                            .setStyle(
                                TextInputStyle.Short
                            )
                            .setRequired(true)
                            .setMaxLength(50);

                    const mode =
                        new TextInputBuilder()
                            .setCustomId(
                                "tournament_mode"
                            )
                            .setLabel(
                                "Tournament / Mode"
                            )
                            .setPlaceholder(
                                "Example: BedWars"
                            )
                            .setStyle(
                                TextInputStyle.Short
                            )
                            .setRequired(true)
                            .setMaxLength(50);

                    modal.addComponents(
                        new ActionRowBuilder()
                            .addComponents(ign),
                        new ActionRowBuilder()
                            .addComponents(mode)
                    );

                    return interaction.showModal(
                        modal
                    );
                }

                // =============================================
                // CLOSE TICKET
                // =============================================

                if (
                    interaction.customId ===
                    "close_ticket"
                ) {

                    if (
                        !isStaff(
                            interaction.member
                        ) &&
                        !interaction.channel.topic?.startsWith(
                            "S1N_SUPPORT_"
                        )
                    ) {
                        return interaction.reply({
                            content:
                                "❌ You cannot close this ticket.",
                            ephemeral: true
                        });
                    }

                    await interaction.reply(
                        "🔒 Closing ticket in **3 seconds**..."
                    );

                    setTimeout(() => {
                        interaction.channel
                            .delete()
                            .catch(() => {});
                    }, 3000);

                    return;
                }

                // =============================================
                // BIRTHDAY
                // =============================================

                if (
                    interaction.customId ===
                    "birthday_register"
                ) {

                    const modal =
                        new ModalBuilder()
                            .setCustomId(
                                "birthday_modal"
                            )
                            .setTitle(
                                "🎂 Birthday Registration"
                            );

                    const name =
                        new TextInputBuilder()
                            .setCustomId(
                                "birthday_name"
                            )
                            .setLabel(
                                "Your Name"
                            )
                            .setPlaceholder(
                                "Enter your name"
                            )
                            .setStyle(
                                TextInputStyle.Short
                            )
                            .setRequired(true);

                    const ign =
                        new TextInputBuilder()
                            .setCustomId(
                                "birthday_ign"
                            )
                            .setLabel(
                                "Minecraft IGN"
                            )
                            .setPlaceholder(
                                "Enter your Minecraft IGN"
                            )
                            .setStyle(
                                TextInputStyle.Short
                            )
                            .setRequired(true);

                    const month =
                        new TextInputBuilder()
                            .setCustomId(
                                "birthday_month"
                            )
                            .setLabel(
                                "Birthday Month"
                            )
                            .setPlaceholder(
                                "Example: August"
                            )
                            .setStyle(
                                TextInputStyle.Short
                            )
                            .setRequired(true);

                    const day =
                        new TextInputBuilder()
                            .setCustomId(
                                "birthday_day"
                            )
                            .setLabel(
                                "Birthday Day"
                            )
                            .setPlaceholder(
                                "Example: 21"
                            )
                            .setStyle(
                                TextInputStyle.Short
                            )
                            .setRequired(true)
                            .setMaxLength(2);

                    modal.addComponents(
                        new ActionRowBuilder()
                            .addComponents(name),
                        new ActionRowBuilder()
                            .addComponents(ign),
                        new ActionRowBuilder()
                            .addComponents(month),
                        new ActionRowBuilder()
                            .addComponents(day)
                    );

                    return interaction.showModal(
                        modal
                    );
                }

                // =============================================
                // ADMIN REGISTER
                // =============================================

                if (
                    interaction.customId ===
                    "admin_register"
                ) {

                    const modal =
                        new ModalBuilder()
                            .setCustomId(
                                "admin_registration_modal"
                            )
                            .setTitle(
                                "🛡️ S1N Staff Application"
                            );

                    const ign =
                        new TextInputBuilder()
                            .setCustomId(
                                "admin_ign"
                            )
                            .setLabel(
                                "Minecraft IGN"
                            )
                            .setPlaceholder(
                                "Enter your Minecraft IGN"
                            )
                            .setStyle(
                                TextInputStyle.Short
                            )
                            .setRequired(true)
                            .setMaxLength(50);

                    const previous =
                        new TextInputBuilder()
                            .setCustomId(
                                "admin_previous"
                            )
                            .setLabel(
                                "Were you ever an admin?"
                            )
                            .setPlaceholder(
                                "Yes/No + guild/server if applicable"
                            )
                            .setStyle(
                                TextInputStyle.Paragraph
                            )
                            .setRequired(true)
                            .setMaxLength(500);

                    const reason =
                        new TextInputBuilder()
                            .setCustomId(
                                "admin_reason"
                            )
                            .setLabel(
                                "Why should we choose you?"
                            )
                            .setPlaceholder(
                                "Tell us why you would be a good S1N staff member..."
                            )
                            .setStyle(
                                TextInputStyle.Paragraph
                            )
                            .setRequired(true)
                            .setMaxLength(1500);

                    modal.addComponents(
                        new ActionRowBuilder()
                            .addComponents(ign),
                        new ActionRowBuilder()
                            .addComponents(previous),
                        new ActionRowBuilder()
                            .addComponents(reason)
                    );

                    return interaction.showModal(
                        modal
                    );
                }

                // =============================================
                // GIVEAWAY ENTRY
                // =============================================

                if (
                    interaction.customId.startsWith(
                        "giveaway_enter_"
                    )
                ) {

                    const id =
                        interaction.customId.replace(
                            "giveaway_enter_",
                            ""
                        );

                    const giveaway =
                        giveaways.get(id);

                    if (!giveaway) {
                        return interaction.reply({
                            content:
                                "❌ This giveaway has ended.",
                            ephemeral: true
                        });
                    }

                    if (
                        giveaway.participants.includes(
                            interaction.user.id
                        )
                    ) {
                        return interaction.reply({
                            content:
                                "⚠️ You are already entered!",
                            ephemeral: true
                        });
                    }

                    giveaway.participants.push(
                        interaction.user.id
                    );

                    giveaways.set(
                        id,
                        giveaway
                    );

                    saveJson(
                        GIVEAWAY_FILE,
                        Object.fromEntries(
                            giveaways
                        )
                    );

                    return interaction.reply({
                        content:
                            "🎉 **YOU'RE IN!** Good luck! 🍀",
                        ephemeral: true
                    });
                }
            }

            // =================================================
            // SELECT MENU
            // =================================================

            if (
                interaction.isStringSelectMenu()
            ) {

                if (
                    interaction.customId ===
                    "color_select"
                ) {

                    const colors = {
                        red: {
                            name: "🔴 Red",
                            color: 0xFF0000
                        },
                        orange: {
                            name: "🟠 Orange",
                            color: 0xFFA500
                        },
                        yellow: {
                            name: "🟡 Yellow",
                            color: 0xFFFF00
                        },
                        green: {
                            name: "🟢 Green",
                            color: 0x00FF00
                        },
                        blue: {
                            name: "🔵 Blue",
                            color: 0x0000FF
                        },
                        purple: {
                            name: "🟣 Purple",
                            color: 0x800080
                        },
                        pink: {
                            name: "🩷 Pink",
                            color: 0xFF69B4
                        },
                        white: {
                            name: "⚪ White",
                            color: 0xFFFFFF
                        }
                    };

                    const selected =
                        colors[
                            interaction.values[0]
                        ];

                    if (!selected) {
                        return interaction.reply({
                            content:
                                "❌ Invalid color.",
                            ephemeral: true
                        });
                    }

                    let role =
                        interaction.guild.roles.cache.find(
                            r =>
                                r.name ===
                                selected.name
                        );

                    if (!role) {

                        role =
                            await interaction.guild.roles.create({
                                name:
                                    selected.name,
                                color:
                                    selected.color,
                                reason:
                                    "S1N Color System"
                            });
                    }

                    const colorRoleNames =
                        Object.values(colors)
                            .map(
                                c => c.name
                            );

                    for (
                        const oldRole of
                        interaction.member.roles.cache.values()
                    ) {

                        if (
                            colorRoleNames.includes(
                                oldRole.name
                            )
                        ) {
                            await interaction.member.roles
                                .remove(oldRole)
                                .catch(() => {});
                        }
                    }

                    await interaction.member.roles
                        .add(role)
                        .catch(() => {});

                    return interaction.reply({
                        content:
                            `🎨 Your color is now **${selected.name}**!`,
                        ephemeral: true
                    });
                }
            }

            // =================================================
            // MODALS
            // =================================================

            if (
                interaction.isModalSubmit()
            ) {

                // =============================================
                // BIRTHDAY MODAL
                // =============================================

                if (
                    interaction.customId ===
                    "birthday_modal"
                ) {

                    const name =
                        interaction.fields.getTextInputValue(
                            "birthday_name"
                        );

                    const ign =
                        interaction.fields.getTextInputValue(
                            "birthday_ign"
                        );

                    const month =
                        interaction.fields.getTextInputValue(
                            "birthday_month"
                        );

                    const day =
                        Number(
                            interaction.fields.getTextInputValue(
                                "birthday_day"
                            )
                        );

                    if (
                        !Number.isInteger(day) ||
                        day < 1 ||
                        day > 31
                    ) {
                        return interaction.reply({
                            content:
                                "❌ Birthday day must be between **1 and 31**.",
                            ephemeral: true
                        });
                    }

                    birthdays.set(
                        interaction.user.id,
                        {
                            name,
                            ign,
                            month,
                            day,
                            userId:
                                interaction.user.id
                        }
                    );

                    saveJson(
                        BIRTHDAY_FILE,
                        Object.fromEntries(
                            birthdays
                        )
                    );

                    const birthdayChannel =
                        interaction.guild.channels.cache.get(
                            BIRTHDAY_ANNOUNCEMENT_CHANNEL_ID
                        );

                    if (
                        birthdayChannel
                    ) {

                        const embed =
                            new EmbedBuilder()
                                .setColor(
                                    0x2b2d31
                                )
                                .setTitle(
                                    "🎂 ✦ S1N BIRTHDAY ✦"
                                )
                                .setDescription(
                                    "━━━━━━━━━━━━━━━━━━━━━━━━\n\n" +
                                    "# 🎉 NEW BIRTHDAY REGISTERED\n\n" +
                                    `👤 **Name:** ${name}\n\n` +
                                    `⛏️ **Minecraft IGN:** ${ign}\n\n` +
                                    `📅 **Birthday:** ${month} ${day}\n\n` +
                                    `💬 **Discord:** ${interaction.user}\n\n` +
                                    "━━━━━━━━━━━━━━━━━━━━━━━━"
                                )
                                .setThumbnail(
                                    interaction.user.displayAvatarURL()
                                )
                                .setFooter({
                                    text:
                                        "S1N Guild • Birthday System"
                                })
                                .setTimestamp();

                        birthdayChannel.send({
                            embeds: [embed]
                        }).catch(() => {});
                    }

                    return interaction.reply({
                        content:
                            "🎂 **Birthday registered!**\n\n" +
                            `👤 ${name}\n` +
                            `⛏️ ${ign}\n` +
                            `📅 ${month} ${day}\n\n` +
                            "🎉 S1N will celebrate with you!",
                        ephemeral: true
                    });
                }

                // =============================================
                // TOURNAMENT MODAL
                // =============================================

                if (
                    interaction.customId ===
                    "tournament_modal"
                ) {

                    const ign =
                        interaction.fields.getTextInputValue(
                            "tournament_ign"
                        );

                    const mode =
                        interaction.fields.getTextInputValue(
                            "tournament_mode"
                        );

                    const tournamentChannel =
                        interaction.guild.channels.cache.find(
                            c =>
                                c.name.includes(
                                    "tournament"
                                )
                        );

                    const embed =
                        new EmbedBuilder()
                            .setColor(
                                0x2b2d31
                            )
                            .setTitle(
                                "🏆 NEW TOURNAMENT REGISTRATION"
                            )
                            .setDescription(
                                `👤 **Discord:** ${interaction.user}\n` +
                                `⛏️ **Minecraft IGN:** ${ign}\n` +
                                `⚔️ **Mode:** ${mode}`
                            )
                            .setThumbnail(
                                interaction.user.displayAvatarURL()
                            )
                            .setTimestamp();

                    if (
                        tournamentChannel
                    ) {
                        tournamentChannel.send({
                            embeds: [embed]
                        }).catch(() => {});
                    }

                    return interaction.reply({
                        content:
                            "🏆 **Tournament registration submitted!**\n\n" +
                            "Staff will provide further tournament information.",
                        ephemeral: true
                    });
                }

                // =============================================
                // ADMIN APPLICATION
                // =============================================

                if (
                    interaction.customId ===
                    "admin_registration_modal"
                ) {

                    const ign =
                        interaction.fields.getTextInputValue(
                            "admin_ign"
                        );

                    const previous =
                        interaction.fields.getTextInputValue(
                            "admin_previous"
                        );

                    const reason =
                        interaction.fields.getTextInputValue(
                            "admin_reason"
                        );

                    const joinedAt =
                        interaction.member.joinedTimestamp;

                    const registration = {
                        userId:
                            interaction.user.id,
                        username:
                            interaction.user.tag,
                        ign,
                        previous,
                        reason,
                        joinedAt,
                        timestamp:
                            Date.now(),
                        status:
                            "pending"
                    };

                    adminRegistrations.set(
                        interaction.user.id,
                        registration
                    );

                    saveJson(
                        ADMIN_REGISTRATION_FILE,
                        Object.fromEntries(
                            adminRegistrations
                        )
                    );

                    const staffChannel =
                        interaction.guild.channels.cache.get(
                            ADMIN_REGISTRATION_CHANNEL_ID
                        );

                    if (
                        staffChannel
                    ) {

                        const embed =
                            new EmbedBuilder()
                                .setColor(
                                    0x2b2d31
                                )
                                .setTitle(
                                    "🛡️ ✦ NEW S1N STAFF APPLICATION ✦"
                                )
                                .setDescription(
                                    "━━━━━━━━━━━━━━━━━━━━━━━━\n\n" +
                                    `👤 **Applicant:** ${interaction.user}\n\n` +
                                    `⛏️ **Minecraft IGN:** ${ign}\n\n` +
                                    `🛡️ **Previous Admin/Staff Experience:**\n${previous}\n\n` +
                                    `💭 **Why should we choose you?**\n${reason}\n\n` +
                                    `📅 **Joined S1N:** <t:${Math.floor(joinedAt / 1000)}:R>\n\n` +
                                    "━━━━━━━━━━━━━━━━━━━━━━━━\n" +
                                    "⏳ **STATUS:** Pending Review"
                                )
                                .setThumbnail(
                                    interaction.user.displayAvatarURL()
                                )
                                .setFooter({
                                    text:
                                        "S1N Staff Applications"
                                })
                                .setTimestamp();

                        const row =
                            new ActionRowBuilder()
                                .addComponents(
                                    new ButtonBuilder()
                                        .setCustomId(
                                            `admin_accept_${interaction.user.id}`
                                        )
                                        .setLabel(
                                            "ACCEPT"
                                        )
                                        .setEmoji("✅")
                                        .setStyle(
                                            ButtonStyle.Success
                                        ),

                                    new ButtonBuilder()
                                        .setCustomId(
                                            `admin_decline_${interaction.user.id}`
                                        )
                                        .setLabel(
                                            "DECLINE"
                                        )
                                        .setEmoji("❌")
                                        .setStyle(
                                            ButtonStyle.Danger
                                        )
                                );

                        await staffChannel.send({
                            embeds: [embed],
                            components: [row]
                        }).catch(() => {});
                    }

                    return interaction.reply({
                        content:
                            "✅ **Application submitted!**\n\n" +
                            "🛡️ Your application has been sent to the S1N staff team.\n" +
                            "⏳ Please wait for a decision.",
                        ephemeral: true
                    });
                }
            }

        } catch (error) {

            console.error(
                "Interaction error:",
                error
            );

            try {

                if (
                    interaction.replied ||
                    interaction.deferred
                ) {

                    await interaction.followUp({
                        content:
                            "❌ Something went wrong.",
                        ephemeral: true
                    });

                } else {

                    await interaction.reply({
                        content:
                            "❌ Something went wrong.",
                        ephemeral: true
                    });
                }

            } catch {}
        }
    }
);

// =====================================================
// GIVEAWAY END
// =====================================================

async function endGiveaway(
    id,
    guild
) {

    const giveaway =
        giveaways.get(id);

    if (!giveaway) {
        return false;
    }

    const channel =
        guild.channels.cache.get(
            giveaway.channelId
        );

    if (!channel) {
        giveaways.delete(id);

        saveJson(
            GIVEAWAY_FILE,
            Object.fromEntries(
                giveaways
            )
        );

        return false;
    }

    let message;

    try {

        message =
            await channel.messages.fetch(
                giveaway.msgId
            );

    } catch {

        giveaways.delete(id);

        saveJson(
            GIVEAWAY_FILE,
            Object.fromEntries(
                giveaways
            )
        );

        return false;
    }

    const participants =
        giveaway.participants || [];

    let winner = null;

    if (
        participants.length > 0
    ) {

        const winnerId =
            participants[
                Math.floor(
                    Math.random() *
                    participants.length
                )
            ];

        winner =
            await guild.members
                .fetch(winnerId)
                .catch(() => null);
    }

    const embed =
        new EmbedBuilder()
            .setColor(0x2b2d31)
            .setTitle(
                "🏆 ✦ GIVEAWAY ENDED ✦"
            )
            .setDescription(
                "━━━━━━━━━━━━━━━━━━━━━━━━\n\n" +
                `🎁 **PRIZE**\n# ${giveaway.prize}\n\n` +
                `👥 **ENTRIES:** ${participants.length}\n\n` +
                (
                    winner
                        ? `🏆 **WINNER:** ${winner}\n`
                        : "❌ **NO VALID WINNER**\n"
                ) +
                "\n━━━━━━━━━━━━━━━━━━━━━━━━"
            )
            .setFooter({
                text:
                    "S1N • Giveaway ended"
            })
            .setTimestamp();

    await message.edit({
        content:
            winner
                ? `🏆 **WINNER:** ${winner}`
                : "❌ Giveaway ended with no valid entries.",
        embeds: [embed],
        components: []
    }).catch(() => {});

    if (winner) {

        await channel.send({
            content:
                `🎉 Congratulations ${winner}!\n\n` +
                `You won **${giveaway.prize}**! 🏆`
        }).catch(() => {});
    }

    giveaways.delete(id);

    saveJson(
        GIVEAWAY_FILE,
        Object.fromEntries(
            giveaways
        )
    );

    return true;
}

// =====================================================
// RESTORE GIVEAWAYS
// =====================================================

async function restoreGiveaways() {

    for (
        const [id, giveaway]
        of giveaways
    ) {

        if (
            !giveaway.endTime
        ) {
            continue;
        }

        const remaining =
            giveaway.endTime -
            Date.now();

        if (
            remaining <= 0
        ) {

            try {

                const guild =
                    await client.guilds.fetch(
                        GUILD_ID
                    );

                await endGiveaway(
                    id,
                    guild
                );

            } catch (error) {

                console.error(
                    "Giveaway restore error:",
                    error
                );
            }

        } else {

            setTimeout(
                async () => {

                    try {

                        const guild =
                            await client.guilds.fetch(
                                GUILD_ID
                            );

                        await endGiveaway(
                            id,
                            guild
                        );

                    } catch (error) {

                        console.error(
                            "Giveaway auto-end error:",
                            error
                        );
                    }

                },
                remaining
            );
        }
    }
}

// =====================================================
// BIRTHDAY CHECKER
// =====================================================

function getMonthNumber(month) {

    const months = {
        january: 1,
        february: 2,
        march: 3,
        april: 4,
        may: 5,
        june: 6,
        july: 7,
        august: 8,
        september: 9,
        october: 10,
        november: 11,
        december: 12
    };

    return months[
        String(month)
            .trim()
            .toLowerCase()
    ] || null;
}

async function checkBirthdays() {

    const now =
        new Date();

    const currentMonth =
        now.getMonth() + 1;

    const currentDay =
        now.getDate();

    for (
        const birthday
        of birthdays.values()
    ) {

        const birthdayMonth =
            getMonthNumber(
                birthday.month
            );

        if (
            birthdayMonth !==
                currentMonth ||
            Number(birthday.day) !==
                currentDay
        ) {
            continue;
        }

        const guild =
            client.guilds.cache.get(
                GUILD_ID
            );

        if (!guild) {
            continue;
        }

        try {

            const member =
                await guild.members.fetch(
                    birthday.userId
                );

            const embed =
                new EmbedBuilder()
                    .setColor(0x2b2d31)
                    .setTitle(
                        "🎂 ✦ HAPPY BIRTHDAY! ✦"
                    )
                    .setDescription(
                        "━━━━━━━━━━━━━━━━━━━━━━━━\n\n" +
                        `# 🎉 HAPPY BIRTHDAY ${birthday.name.toUpperCase()}!\n\n` +
                        "Everyone at **S1N Guild** wishes you an amazing birthday! 🎉\n\n" +
                        `⛏️ **Minecraft IGN:** ${birthday.ign}\n\n` +
                        "Have an incredible day! ❤️\n\n" +
                        "━━━━━━━━━━━━━━━━━━━━━━━━"
                    )
                    .setThumbnail(
                        member.user.displayAvatarURL()
                    )
                    .setFooter({
                        text:
                            "S1N Guild • Birthday System"
                    })
                    .setTimestamp();

            // DM the birthday person
            await member.send({
                embeds: [embed]
            }).catch(() => {});

            // Public announcement
            const channel =
                guild.channels.cache.get(
                    BIRTHDAY_ANNOUNCEMENT_CHANNEL_ID
                );

            if (channel) {

                await channel.send({
                    content:
                        `🎉 Everyone wish ${member} a **HAPPY BIRTHDAY!** 🎂`,
                    embeds: [embed]
                }).catch(() => {});
            }

        } catch {}
    }
}

// =====================================================
// READY
// =====================================================

client.once(
    Events.ClientReady,
    async () => {

        console.log(
            `✅ S1N Bot Online: ${client.user.tag}`
        );

        client.user.setPresence({
            activities: [
                {
                    name:
                        "S1N Guild ⚔️",
                    type:
                        ActivityType.Watching
                }
            ],
            status:
                "online"
        });

        const rest =
            new REST({
                version: "10"
            }).setToken(
                TOKEN
            );

        try {

            await rest.put(
                Routes.applicationGuildCommands(
                    CLIENT_ID,
                    GUILD_ID
                ),
                {
                    body:
                        commands
                }
            );

            console.log(
                "✅ S1N slash commands registered."
            );

        } catch (error) {

            console.error(
                "❌ Slash command registration error:",
                error
            );
        }

        await restoreGiveaways();

        // Check birthdays immediately
        await checkBirthdays();

        // Check every hour
        setInterval(
            async () => {
                await checkBirthdays();
            },
            60 * 60 * 1000
        );
    }
);

// =====================================================
// LOGIN
// =====================================================

client.login(TOKEN);


// =====================================================
// S1N GAMBLES WEB API / DISCORD OAUTH
// =====================================================

function parseCookies(req) {
    const header = req.headers.cookie || "";
    const cookies = {};
    for (const part of header.split(";")) {
        const index = part.indexOf("=");
        if (index === -1) continue;
        cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    }
    return cookies;
}

function getWebUser(req) {
    const sid = parseCookies(req).s1n_session;
    return sid ? webSessions.get(sid) || null : null;
}

function sendJson(res, status, data, origin) {
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": origin || S1N_WEBSITE_URL,
        "Access-Control-Allow-Credentials": "true",
        "Vary": "Origin"
    });
    res.end(JSON.stringify(data));
}

function startWebServer() {
    const server = http.createServer(async (req, res) => {
        const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        const origin = req.headers.origin || S1N_WEBSITE_URL;

        if (req.method === "OPTIONS") {
            res.writeHead(204, {
                "Access-Control-Allow-Origin": origin,
                "Access-Control-Allow-Credentials": "true",
                "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type",
                "Vary": "Origin"
            });
            return res.end();
        }

        try {
            if (requestUrl.pathname === "/auth/discord" && req.method === "GET") {
                if (!DISCORD_CLIENT_SECRET || !DISCORD_OAUTH_REDIRECT_URI) {
                    return sendJson(res, 500, { error: "Discord OAuth is not configured on Railway." }, origin);
                }
                const oauthUrl = new URL("https://discord.com/oauth2/authorize");
                oauthUrl.searchParams.set("client_id", CLIENT_ID);
                oauthUrl.searchParams.set("response_type", "code");
                oauthUrl.searchParams.set("redirect_uri", DISCORD_OAUTH_REDIRECT_URI);
                oauthUrl.searchParams.set("scope", "identify");
                res.writeHead(302, { Location: oauthUrl.toString() });
                return res.end();
            }

            if (requestUrl.pathname === "/auth/discord/callback" && req.method === "GET") {
                const code = requestUrl.searchParams.get("code");
                if (!code || !DISCORD_CLIENT_SECRET || !DISCORD_OAUTH_REDIRECT_URI) {
                    res.writeHead(302, { Location: `${S1N_WEBSITE_URL}/?discord=error` });
                    return res.end();
                }
                const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body: new URLSearchParams({
                        client_id: CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET,
                        grant_type: "authorization_code", code, redirect_uri: DISCORD_OAUTH_REDIRECT_URI
                    })
                });
                if (!tokenResponse.ok) {
                    res.writeHead(302, { Location: `${S1N_WEBSITE_URL}/?discord=error` });
                    return res.end();
                }
                const tokenData = await tokenResponse.json();
                const userResponse = await fetch("https://discord.com/api/users/@me", {
                    headers: { Authorization: `Bearer ${tokenData.access_token}` }
                });
                if (!userResponse.ok) {
                    res.writeHead(302, { Location: `${S1N_WEBSITE_URL}/?discord=error` });
                    return res.end();
                }
                const discordUser = await userResponse.json();
                const sessionId = crypto.randomBytes(32).toString("hex");
                webSessions.set(sessionId, {
                    id: discordUser.id, username: discordUser.username,
                    global_name: discordUser.global_name || discordUser.username,
                    avatar: discordUser.avatar || null
                });
                res.writeHead(302, {
                    "Set-Cookie": `s1n_session=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=604800`,
                    Location: `${S1N_WEBSITE_URL}/?discord=connected`
                });
                return res.end();
            }

            if (requestUrl.pathname === "/auth/logout" && req.method === "POST") {
                const sid = parseCookies(req).s1n_session;
                if (sid) webSessions.delete(sid);
                return sendJson(res, 200, { ok: true }, origin);
            }

            if (requestUrl.pathname === "/api/me" && req.method === "GET") {
                const user = getWebUser(req);
                if (!user) return sendJson(res, 200, { authenticated: false, balance: 0 }, origin);
                return sendJson(res, 200, { authenticated: true, user, balance: getCredits(user.id) }, origin);
            }

            if (requestUrl.pathname === "/api/balance" && req.method === "POST") {
                const user = getWebUser(req);
                if (!user) return sendJson(res, 401, { error: "Not authenticated" }, origin);
                let body = "";
                for await (const chunk of req) body += chunk;
                let data;
                try { data = JSON.parse(body || "{}"); } catch { return sendJson(res, 400, { error: "Invalid JSON" }, origin); }
                const amount = Number(data.amount);
                if (!Number.isFinite(amount) || Math.abs(amount) > 100000000) {
                    return sendJson(res, 400, { error: "Invalid credit amount" }, origin);
                }
                return sendJson(res, 200, { ok: true, balance: addCredits(user.id, amount) }, origin);
            }

            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Not found");
        } catch (error) {
            console.error("S1N web server error:", error);
            if (!res.headersSent) sendJson(res, 500, { error: "Internal server error" }, origin);
            else res.end();
        }
    });

    server.listen(API_PORT, () => console.log(`🌐 S1N Gambles API running on port ${API_PORT}`));
}

startWebServer();

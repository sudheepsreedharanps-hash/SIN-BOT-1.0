require("dotenv").config();

const fs = require("fs");
const path = require("path");
const net = require("net");

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
    maintenance: false
});

const warnings = new Map();

// =====================================================
// MINECRAFT SERVER STATUS - BLOCKS MC
// =====================================================

const MC_SERVER_HOST = "play.blocksmc.com";
const MC_SERVER_PORT = 25565;
const MC_SUPPORTED_VERSIONS = "1.8.9 → 1.21.x";
const MC_WEBSITE_URL = "https://blocksmc.com";
const MC_STATUS_TIMEOUT = 7000;
const MC_REFRESH_COOLDOWN = 15 * 1000;
const MC_AUTO_UPDATE_INTERVAL = 60 * 1000;
const MC_STATUS_CHANNEL_ID = process.env.MC_STATUS_CHANNEL_ID || null;
const MC_STATUS_MESSAGE_FILE = path.join(__dirname, "minecraft-status-message.json");

const mcRefreshCooldowns = new Map();

function encodeVarInt(value) {
    const bytes = [];
    let unsigned = value >>> 0;

    do {
        let temp = unsigned & 0x7f;
        unsigned >>>= 7;
        if (unsigned !== 0) temp |= 0x80;
        bytes.push(temp);
    } while (unsigned !== 0);

    return Buffer.from(bytes);
}

function encodeString(value) {
    const data = Buffer.from(value, "utf8");
    return Buffer.concat([
        encodeVarInt(data.length),
        data
    ]);
}

function encodePacket(packetId, payload = Buffer.alloc(0)) {
    const body = Buffer.concat([
        encodeVarInt(packetId),
        payload
    ]);

    return Buffer.concat([
        encodeVarInt(body.length),
        body
    ]);
}

function encodeLong(value) {
    const buffer = Buffer.alloc(8);
    buffer.writeBigInt64BE(BigInt(value));
    return buffer;
}

function tryReadVarInt(buffer, offset = 0) {
    let value = 0;
    let shift = 0;

    for (let i = 0; i < 5; i++) {
        if (offset + i >= buffer.length) return null;

        const byte = buffer[offset + i];
        value |= (byte & 0x7f) << shift;

        if ((byte & 0x80) === 0) {
            return {
                value: value >>> 0,
                bytes: i + 1
            };
        }

        shift += 7;
    }

    throw new Error("Invalid Minecraft VarInt");
}

function createMinecraftReader(socket) {
    let buffer = Buffer.alloc(0);
    let closed = false;
    const waiters = [];

    const failAll = error => {
        closed = true;
        while (waiters.length) {
            waiters.shift().reject(error);
        }
    };

    const process = () => {
        while (waiters.length) {
            const waiter = waiters[0];
            const lengthInfo = tryReadVarInt(buffer);
            if (!lengthInfo) return;

            const total = lengthInfo.bytes + lengthInfo.value;
            if (buffer.length < total) return;

            const packet = buffer.subarray(
                lengthInfo.bytes,
                total
            );

            buffer = buffer.subarray(total);
            waiters.shift().resolve(packet);
        }
    };

    const onData = chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        try {
            process();
        } catch (error) {
            failAll(error);
            socket.destroy();
        }
    };

    const onError = error => failAll(error);
    const onClose = () => failAll(new Error("Minecraft server connection closed"));

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);

    return {
        readPacket(timeout = MC_STATUS_TIMEOUT) {
            const existing = tryReadVarInt(buffer);
            if (existing && buffer.length >= existing.bytes + existing.value) {
                const total = existing.bytes + existing.value;
                const packet = buffer.subarray(existing.bytes, total);
                buffer = buffer.subarray(total);
                return Promise.resolve(packet);
            }

            if (closed) {
                return Promise.reject(
                    new Error("Minecraft server connection closed")
                );
            }

            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    const index = waiters.findIndex(
                        item => item.resolve === wrappedResolve
                    );

                    if (index !== -1) waiters.splice(index, 1);
                    reject(new Error("Minecraft server response timed out"));
                }, timeout);

                const wrappedResolve = packet => {
                    clearTimeout(timer);
                    resolve(packet);
                };

                const wrappedReject = error => {
                    clearTimeout(timer);
                    reject(error);
                };

                waiters.push({
                    resolve: wrappedResolve,
                    reject: wrappedReject
                });
                process();
            });
        },
        cleanup() {
            socket.removeListener("data", onData);
            socket.removeListener("error", onError);
            socket.removeListener("close", onClose);
        }
    };
}

function decodeMinecraftString(packet, offset) {
    const lengthInfo = tryReadVarInt(packet, offset);
    if (!lengthInfo) throw new Error("Invalid Minecraft string length");

    const start = offset + lengthInfo.bytes;
    const end = start + lengthInfo.value;

    if (end > packet.length) {
        throw new Error("Invalid Minecraft string payload");
    }

    return {
        value: packet.subarray(start, end).toString("utf8"),
        nextOffset: end
    };
}

async function queryMinecraftServer() {
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        let settled = false;
        let reader = null;

        const finish = (error, result) => {
            if (settled) return;
            settled = true;

            if (reader) reader.cleanup();
            socket.destroy();

            if (error) reject(error);
            else resolve(result);
        };

        socket.setTimeout(MC_STATUS_TIMEOUT);

        socket.once("timeout", () => {
            finish(new Error("Minecraft server connection timed out"));
        });

        socket.once("error", error => {
            finish(error);
        });

        socket.connect(
            MC_SERVER_PORT,
            MC_SERVER_HOST,
            async () => {
                try {
                    reader = createMinecraftReader(socket);

                    // Status handshake. Protocol version is deliberately neutral;
                    // the server's own response is used for the displayed version.
                    const handshakePayload = Buffer.concat([
                        encodeVarInt(760),
                        encodeString(MC_SERVER_HOST),
                        Buffer.from([
                            (MC_SERVER_PORT >> 8) & 0xff,
                            MC_SERVER_PORT & 0xff
                        ]),
                        encodeVarInt(1)
                    ]);

                    socket.write(
                        encodePacket(0x00, handshakePayload)
                    );

                    socket.write(
                        encodePacket(0x00)
                    );

                    const statusPacket =
                        await reader.readPacket();

                    const statusPacketId =
                        tryReadVarInt(statusPacket);

                    if (!statusPacketId || statusPacketId.value !== 0x00) {
                        throw new Error("Invalid Minecraft status response");
                    }

                    const statusJson =
                        decodeMinecraftString(
                            statusPacket,
                            statusPacketId.bytes
                        ).value;

                    const status = JSON.parse(statusJson);

                    const pingStartedAt = Date.now();
                    const pingPayload = encodeLong(pingStartedAt);

                    socket.write(
                        encodePacket(0x01, pingPayload)
                    );

                    const pongPacket =
                        await reader.readPacket();

                    const pongId =
                        tryReadVarInt(pongPacket);

                    if (!pongId || pongId.value !== 0x01) {
                        throw new Error("Invalid Minecraft pong response");
                    }

                    const ping = Math.max(
                        0,
                        Date.now() - pingStartedAt
                    );

                    const players = status.players || {};
                    const version = status.version || {};

                    finish(null, {
                        online: true,
                        players: Number.isFinite(players.online)
                            ? players.online
                            : 0,
                        maxPlayers: Number.isFinite(players.max)
                            ? players.max
                            : 0,
                        version: version.name || "Unknown",
                        ping,
                        retrievedAt: Date.now(),
                        raw: status
                    });
                } catch (error) {
                    finish(error);
                }
            }
        );
    });
}

function createMinecraftStatusEmbed(result) {
    const embed = new EmbedBuilder()
        .setTitle("🎮 BLOCKS MC")
        .setColor(result.online ? 0x57F287 : 0xED4245)
        .addFields(
            {
                name: "🟢 Status",
                value: result.online
                    ? "Online"
                    : "Offline",
                inline: true
            },
            {
                name: "👥 Players",
                value: result.online
                    ? `${result.players.toLocaleString()} / ${result.maxPlayers.toLocaleString()}`
                    : "Unavailable",
                inline: true
            },
            {
                name: "🎮 Server Version",
                value: result.online
                    ? String(result.version).slice(0, 1024)
                    : "Unavailable",
                inline: true
            },
            {
                name: "🎮 Supported Versions",
                value: MC_SUPPORTED_VERSIONS,
                inline: true
            },
            {
                name: "📡 Server Ping",
                value: result.online && Number.isFinite(result.ping)
                    ? `${result.ping} ms`
                    : "Unavailable",
                inline: true
            },
            {
                name: "🌐 Server Address",
                value: `\`${MC_SERVER_HOST}\``,
                inline: true
            }
        )
        .setFooter({
            text: result.online
                ? "BlocksMC • Live server status"
                : "BlocksMC • Live server information unavailable"
        })
        .setTimestamp(
            result.retrievedAt || Date.now()
        );

    if (!result.online) {
        embed.setDescription(
            "🔴 **Status: Offline**\n\n" +
            "Live server information could not be retrieved. " +
            "The server may be offline, unreachable, rate-limited, or returned an invalid response."
        );
    }

    return embed;
}

function createMinecraftStatusButtons() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel("Website")
            .setEmoji("🌐")
            .setStyle(ButtonStyle.Link)
            .setURL(MC_WEBSITE_URL),
        new ButtonBuilder()
            .setCustomId("mcstatus_refresh")
            .setLabel("Refresh")
            .setEmoji("🔄")
            .setStyle(ButtonStyle.Secondary)
    );
}

function isMinecraftRefreshRateLimited(userId) {
    const now = Date.now();
    const previous = mcRefreshCooldowns.get(userId) || 0;

    if (now - previous < MC_REFRESH_COOLDOWN) {
        return Math.ceil(
            (MC_REFRESH_COOLDOWN - (now - previous)) / 1000
        );
    }

    mcRefreshCooldowns.set(userId, now);
    return 0;
}

async function getMinecraftStatusResult() {
    try {
        return await queryMinecraftServer();
    } catch (error) {
        console.error(
            "❌ BlocksMC status query failed:",
            error.message || error
        );

        return {
            online: false,
            players: 0,
            maxPlayers: 0,
            version: "Unavailable",
            ping: null,
            retrievedAt: Date.now(),
            error: error.message || "Unknown server status error"
        };
    }
}

async function updateMinecraftStatusMessage(channel, messageId = null) {
    if (!channel || !channel.isTextBased()) return null;

    const result = await getMinecraftStatusResult();
    const payload = {
        embeds: [createMinecraftStatusEmbed(result)],
        components: [createMinecraftStatusButtons()]
    };

    try {
        let message = null;

        if (messageId) {
            message = await channel.messages.fetch(messageId).catch(() => null);
        }

        if (message) {
            await message.edit(payload);
        } else {
            message = await channel.send(payload);
        }

        return message;
    } catch (error) {
        console.error(
            "❌ BlocksMC Discord status message update failed:",
            error.message || error
        );
        return null;
    }
}

async function startMinecraftAutoStatus() {
    if (!MC_STATUS_CHANNEL_ID) {
        console.log(
            "ℹ️ BlocksMC automatic status is disabled. Set MC_STATUS_CHANNEL_ID to enable it."
        );
        return;
    }

    const channel = await client.channels.fetch(
        MC_STATUS_CHANNEL_ID
    ).catch(() => null);

    if (!channel || !channel.isTextBased()) {
        console.error(
            "❌ MC_STATUS_CHANNEL_ID is invalid or is not a text channel."
        );
        return;
    }

    const saved = loadJson(
        MC_STATUS_MESSAGE_FILE,
        { messageId: null }
    );

    let message = await updateMinecraftStatusMessage(
        channel,
        saved.messageId
    );

    if (message) {
        saveJson(
            MC_STATUS_MESSAGE_FILE,
            { messageId: message.id, channelId: channel.id }
        );
    }

    setInterval(async () => {
        try {
            const current = loadJson(
                MC_STATUS_MESSAGE_FILE,
                { messageId: null }
            );

            message = await updateMinecraftStatusMessage(
                channel,
                current.messageId
            );

            if (message) {
                saveJson(
                    MC_STATUS_MESSAGE_FILE,
                    { messageId: message.id, channelId: channel.id }
                );
            }
        } catch (error) {
            console.error(
                "❌ BlocksMC automatic status update failed:",
                error.message || error
            );
        }
    }, MC_AUTO_UPDATE_INTERVAL);

    console.log(
        `✅ BlocksMC automatic status enabled in channel ${channel.id}.`
    );
}

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
        .setName("mcstatus")
        .setDescription(
            "View the live BlocksMC server status"
        ),

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

                // =============================================
                // MINECRAFT STATUS
                // =============================================

                if (
                    commandName ===
                    "mcstatus"
                ) {
                    await interaction.deferReply();

                    const result =
                        await getMinecraftStatusResult();

                    return interaction.editReply({
                        embeds: [
                            createMinecraftStatusEmbed(result)
                        ],
                        components: [
                            createMinecraftStatusButtons()
                        ]
                    });
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
                                "🎮 `/mcstatus` — View live BlocksMC status\n\n" +

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

    // Split message using |
    const lines =
        rawMessage
            .split("|")
            .map(line => line.trim())
            .filter(Boolean);

    // Clean, aesthetic announcement body
    const description =
        lines
            .map(line => `**${line}**`)
            .join("\n\n");

    const embed =
        new EmbedBuilder()
            .setColor(0x5865F2)

            // S1N BOT LOGO / SERVER ICON
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
                        Object.fromEntries(
                            giveaways
                        )
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
                // BLOCKS MC STATUS REFRESH
                // =============================================

                if (
                    interaction.customId ===
                    "mcstatus_refresh"
                ) {
                    const remaining =
                        isMinecraftRefreshRateLimited(
                            interaction.user.id
                        );

                    if (remaining > 0) {
                        return interaction.reply({
                            content:
                                `⏳ Please wait ${remaining}s before refreshing the BlocksMC status again.`,
                            ephemeral: true
                        });
                    }

                    await interaction.deferUpdate();

                    const result =
                        await getMinecraftStatusResult();

                    await interaction.message.edit({
                        embeds: [
                            createMinecraftStatusEmbed(result)
                        ],
                        components: [
                            createMinecraftStatusButtons()
                        ]
                    }).catch(error => {
                        console.error(
                            "❌ BlocksMC refresh edit failed:",
                            error.message || error
                        );
                    });

                    return;
                }

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

                    // Only staff can review applications
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

                    // Notify applicant
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

                    } catch {
                        // Applicant may have DMs disabled
                    }

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

        // Optional BlocksMC automatic status message
        await startMinecraftAutoStatus();
    }
);

// =====================================================
// LOGIN
// =====================================================

client.login(TOKEN);

const fs = require('fs-extra'); 
const { join } = require('path');

/* ===============================
   📦 إعداد مسارات التخزين
================================ */
const TMP_DIR = join(process.cwd(), 'tmp');
const DATA_FILE = join(TMP_DIR, 'badPlugins.json');

// دوال حفظ وقراءة القائمة
function saveList(list) {
    fs.ensureDirSync(TMP_DIR);
    fs.writeJsonSync(DATA_FILE, list, { spaces: 2 });
}

function loadList() {
    try {
        return fs.readJsonSync(DATA_FILE);
    } catch {
        return [];
    }
}

module.exports = {
    command: 'بايز',             
    aliases: ['خربان', 'فحص_الاوامر'],
    description: '🔍 فحص الأوامر المعطلة التي لا تتوافق مع نظام البوت',
    usage: '.بايز | .بايز احذف <أرقام> | .بايز احذف خربان',
    category: 'مالك',
    elite: true,                 

    async execute(sock, msg, args) {
        const pluginDir = join(process.cwd(), 'plugins');
        const disabledDir = join(pluginDir, 'disabled');
        fs.ensureDirSync(disabledDir);

        /* ===============================
           🗑️ قسم التعطيل (النقل لمجلد disabled)
        ================================ */
        if (args[0] === 'احذف') {
            const storedList = loadList();

            if (!storedList.length) {
                return msg.reply('⚠️ لا توجد قائمة سابقة. استخدم `.بايز` أولاً لإجراء فحص.');
            }

            const isAll = args[1] === 'خربان';
            const nums = args.slice(1).map(Number).filter(n => !isNaN(n));

            if (!isAll && !nums.length) {
                return msg.reply('⚠️ طريقة الاستخدام:\n.بايز احذف 1 2\nأو\n.بايز احذف خربان');
            }

            const moved = [];
            const failed = [];

            const targets = isAll ? storedList : nums.map(n => storedList[n - 1]).filter(Boolean);

            for (const item of targets) {
                const src = join(pluginDir, item.file);
                const dest = join(disabledDir, item.file);

                try {
                    if (fs.existsSync(src)) {
                        fs.moveSync(src, dest, { overwrite: true });
                        moved.push(item.file);
                    }
                } catch (e) {
                    failed.push(item.file);
                }
            }

            if (isAll) saveList([]); 

            let reply = `🗑️ *نتيجة عملية التعطيل:*\n\n`;
            if (moved.length) reply += `✅ *تم تعطيل ونقل:*\n${moved.map(f => `• ${f}`).join('\n')}\n\n`;
            if (failed.length) reply += `❌ *فشل في نقل:*\n${failed.map(f => `• ${f}`).join('\n')}`;

            return msg.reply(reply.trim());
        }

        /* ===============================
           🔍 قسم الفحص 
        ================================ */
        // إرسال الرسالة الأولية وحفظ كائن الرسالة
        const statusMsg = await msg.reply('⚡ جاري فحص جميع الإضافات حسب معايير النظام...');
        
        const files = fs.readdirSync(pluginDir).filter(f => f.endsWith('.js'));
        const badPlugins = [];
        const seenCommands = new Set(); 

        for (const file of files) {
            const filePath = join(pluginDir, file);
            let plugin;

            try {
                delete require.cache[require.resolve(filePath)];
                plugin = require(filePath);
            } catch (err) {
                badPlugins.push({ file, issue: `❌ خطأ برمجي: ${err.message.split('\n')[0]}` });
                continue;
            }

            if (!plugin.command) {
                badPlugins.push({ file, issue: '⚠️ متغير `command` مفقود.' });
                continue;
            }
            if (typeof plugin.command !== 'string') {
                badPlugins.push({ file, issue: '⚠️ الـ `command` يجب أن يكون نص (String).' });
                continue;
            }
            if (typeof plugin.execute !== 'function') {
                badPlugins.push({ file, issue: '⚠️ دالة `execute` غير موجودة.' });
                continue;
            }

            const cmdName = plugin.command.toLowerCase().trim();
            const aliases = Array.isArray(plugin.aliases) ? plugin.aliases.map(a => a.toLowerCase().trim()) : [];
            const allNames = [cmdName, ...aliases];

            let hasConflict = false;
            for (const name of allNames) {
                if (seenCommands.has(name)) {
                    badPlugins.push({ file, issue: `🔁 تضارب: الاسم '${name}' مستخدم في ملف آخر.` });
                    hasConflict = true;
                    break;
                }
            }

            if (!hasConflict) {
                allNames.forEach(name => seenCommands.add(name));
            }
        }

        const jid = msg.key.remoteJid;

        if (badPlugins.length === 0) {
            saveList([]);
            // تعديل الرسالة باستخدام sock.sendMessage وتمرير الـ key
            return sock.sendMessage(jid, { 
                text: '✅ جميع الأوامر متوافقة تماماً مع بنية النظام وتعمل بكفاءة 🎯', 
                edit: statusMsg.key 
            });
        }

        saveList(badPlugins);

        const report = badPlugins.map((p, i) => `*${i + 1}. ${p.file}*\n${p.issue}`).join('\n\n');

        const finalMessage = 
`╭─〔 ⚠️ تقرير فحص التوافق 〕─╮

${report}

╰────〔 ${badPlugins.length} ملف غير متوافق 〕────╯

💡 *لتعطيل الملفات التالفة:*
استخدم: \`.بايز احذف 1 2\`
أو لتعطيل الكل: \`.بايز احذف خربان\``;

        // التعديل هنا للرسالة النهائية
        await sock.sendMessage(jid, { 
            text: finalMessage, 
            edit: statusMsg.key 
        });
    }
};

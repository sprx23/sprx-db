import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const isNode = typeof process !== 'undefined' && process.versions?.node;

class SDB {
    constructor(data, isfile) {
        this.__objects = new Map();
        this.__masterTable = new Map();

        if (isfile) {
            if (!isNode) throw "Cannot read file in browser env."
            data = readFileSync()
        }
    }

    setObject(id, data, type = 'TEXT') {
        if (id.startsWith('__sdb_internal')) {
            throw new Error('ID starting with __sdb_internal not allowed');
        }

        if (type === "FILE") {
            data = readFileSync(data)
        }

        if (type === "DIR") {
            let dirname = data
            data = ""
            const entries = readdirSync(dirname, { withFileTypes: true })
            for (const e of entries) {
                if (e.isFile()) {
                    const path = join(dirname, e.name)
                    this.__objects.set(id + "$" + path, readFileSync(path))
                    this.__masterTable.set(id + "$" + path, {
                        creTime: Date.now(),
                        modTime: Date.now(),
                        version: 1,
                        type: "FILE"
                    })
                    data += JSON.stringify(id + "$" + path) + "\n"
                }
            }
        }

        this.__objects.set(id, data);
        this.__masterTable.set(id, {
            creTime: Date.now(),
            modTime: Date.now(),
            version: 1,
            type
        });
    }

    getObject(id) {
        return this.__objects.get(id)
    }

    getStat(id) {
        return this.__masterTable.get(id)
    }

    serialize(comment = '') {
        let top = '#!SPRXDB t01\n' + Date.now() + '\n';

        let header =
            comment.length + ' ' + comment + '\n' +
            'HEAD\n';

        const meta = new Map();
        let data = '';
        let pos = 0;

        for (const [id, valueRaw] of this.__objects) {
            let value = valueRaw;

            if (this.__masterTable.get(id).type === "FILE" || this.__masterTable.get(id).type === "BIN") {
                value = valueRaw.toString("base64")
            }

            if (typeof value !== 'string') {
                value = JSON.stringify(value);
            }

            data += '\nOBJ';
            pos += 4;

            data += value;
            meta.set(id, { pos, len: value.length });

            pos += value.length;
        }

        for (const [id, info] of this.__masterTable) {
            const m = meta.get(id);
            if (!m) continue;

            const row = [
                id,
                info.type,
                info.creTime,
                info.modTime,
                info.version,
                m.pos,
                m.len
            ];

            header += JSON.stringify(row).slice(1, -1) + '\n';
        }

        header += 'HEAD END';
        const footer = '\nEND';

        const payload = header + data + footer;
        const hash = createHash('md5').update(payload).digest('hex');

        return top + hash + '\n' + payload;
    }
}

/* usage */
const sdb = new SDB();
sdb.addObject('mydata', 'Hello!');
sdb.addObject('myfile', 'package.json', 'FILE')
console.log(sdb.serialize("Hello, World!"))
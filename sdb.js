import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

class SDB {
    constructor() {
        this.__objects = new Map();
        this.__masterTable = new Map();
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

    serializeToFile(path, comment) {
        writeFileSync(path, sdb.serialize(comment))
    }

    // Deserialize a serialized SDB string and return a populated SDB instance.
    // Throws on invalid format or checksum mismatch.
    static deserialize(serialized) {
        const MAGIC = '#!SPRXDB t01\n';
        if (!serialized.startsWith(MAGIC)) {
            throw new Error('Invalid SDB magic header');
        }

        let rest = serialized.slice(MAGIC.length);

        const timestampEnd = rest.indexOf('\n');
        if (timestampEnd === -1) throw new Error('Invalid SDB: missing timestamp');
        const timestamp = rest.slice(0, timestampEnd);
        rest = rest.slice(timestampEnd + 1);

        const hashEnd = rest.indexOf('\n');
        if (hashEnd === -1) throw new Error('Invalid SDB: missing hash');
        const hash = rest.slice(0, hashEnd);
        const payload = rest.slice(hashEnd + 1);

        // verify checksum
        const computed = createHash('md5').update(payload).digest('hex');
        if (computed !== hash) {
            throw new Error('Checksum mismatch');
        }

        // parse header / data
        const headMarker = '\nHEAD\n';
        const headMarkerIndex = payload.indexOf(headMarker);
        if (headMarkerIndex === -1) throw new Error('Invalid SDB: missing HEAD marker');

        // header prefix contains "<len> <comment>"
        const headerPrefix = payload.slice(0, headMarkerIndex);
        const firstSpace = headerPrefix.indexOf(' ');
        if (firstSpace === -1) throw new Error('Invalid SDB header comment format');
        const commentLenStr = headerPrefix.slice(0, firstSpace);
        const commentLen = parseInt(commentLenStr, 10);
        const comment = headerPrefix.slice(firstSpace + 1);
        // optional: verify comment length (note: comment may contain multi-byte utf8; original used .length)
        if (!Number.isNaN(commentLen) && commentLen !== comment.length) {
            // not fatal, but warn? we'll not throw; keep original comment
        }

        // find end of header (HEAD END)
        const headEndMarker = 'HEAD END';
        const headEndIndex = payload.indexOf(headEndMarker, headMarkerIndex);
        if (headEndIndex === -1) throw new Error('Invalid SDB: missing HEAD END');

        // extract header rows between 'HEAD\n' and 'HEAD END'
        const headerRowsStart = headMarkerIndex + headMarker.length;
        const headerBody = payload.slice(headerRowsStart, headEndIndex);
        const headerLines = headerBody.split('\n').map(l => l.trim()).filter(l => l.length > 0);

        // data area is between headEndIndex + length and the footer "\nEND"
        const dataStart = headEndIndex + headEndMarker.length;
        const footerIndex = payload.indexOf('\nEND', dataStart);
        if (footerIndex === -1) throw new Error('Invalid SDB: missing footer END');
        const dataString = payload.slice(dataStart, footerIndex);

        const sdb = new SDB();

        for (const line of headerLines) {
            // each line is JSON array contents without surrounding [ ]
            // rebuild and parse
            let arr;
            try {
                arr = JSON.parse('[' + line + ']');
            } catch (e) {
                // skip malformed row
                continue;
            }
            // expected: [id, type, creTime, modTime, version, pos, len]
            const [id, type, creTime, modTime, version, pos, len] = arr;

            if (typeof pos !== 'number' || typeof len !== 'number') {
                continue;
            }

            const rawValue = dataString.substr(pos, len);

            let value = rawValue;
            if (type === 'FILE' || type === 'BIN') {
                // decode base64 back to Buffer
                value = Buffer.from(rawValue, 'base64');
            } else {
                // for TEXT (and other non-binary) try JSON.parse if it was JSON serialized
                // attempt parse, otherwise keep raw string
                try {
                    value = JSON.parse(rawValue);
                } catch (e) {
                    value = rawValue;
                }
            }

            sdb.__objects.set(id, value);
            sdb.__masterTable.set(id, {
                creTime: creTime,
                modTime: modTime,
                version: version,
                type: type
            });
        }

        return sdb;
    }

    // Convenience: deserialize from a file path
    static deserializeFile(path) {
        const content = readFileSync(path, 'utf8');
        return SDB.deserialize(content);
    }
}

/* usage */
const sdb = new SDB();
sdb.setObject('mydata', 'Hello!');
writeFileSync("output.sdb", sdb.serialize("Hello, World!"))

// Example: read back
const loaded = SDB.deserializeFile('output.sdb');
console.log(loaded.getObject('mydata'));

export default SDB;
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import generate from "@babel/generator";
import * as t from "@babel/types";

const code = `
let a = 1;
let b = 2;

console.log(a + b);
console.log(a + b);
`;

const ast = parse(code, { sourceType: "module" });

traverse(ast, {
	Program(path) {
		// 1️⃣ pick statements to extract (example: last 2)
		const stmts = path.node.body.slice(-2);

		// 2️⃣ find identifiers used inside
		const used = new Set();
		traverse(
			t.program(stmts),
			{
				Identifier(p) {
					used.add(p.node.name);
				}
			},
			path.scope,
			path
		);

		// filter to variables defined outside
		const params = [...used].filter(name => path.scope.hasBinding(name));

		// 3️⃣ create function
		const func = t.functionDeclaration(
			t.identifier("extracted"),
			params.map(p => t.identifier(p)),
			t.blockStatement(stmts)
		);

		// 4️⃣ replace statements with call
		const call = t.expressionStatement(
			t.callExpression(
				t.identifier("extracted"),
				params.map(p => t.identifier(p))
			)
		);

		path.node.body.splice(-2, 2, call, call);

		// 5️⃣ insert function at top
		path.node.body.unshift(func);

		path.stop();
	}
});

console.log(generate(ast).code);

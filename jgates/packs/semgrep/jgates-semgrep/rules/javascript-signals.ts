// TypeScript fixture of javascript-signals.yaml: forms that only exist in TypeScript. Never run.

// ruleid: jgates.js.uses-graphql
import type { GraphQLSchema } from "graphql";
// ruleid: jgates.js.uses-jwt
import jwtLib = require("jsonwebtoken");
// ruleid: jgates.js.uses-file-upload
const upload: unknown = FileInterceptor("file");
// ok: jgates.js.uses-graphql
type NoteGql = "import type { GraphQLSchema } from 'graphql'";
// ok: jgates.js.uses-jwt
type NoteJwt = "import jwtLib = require('jsonwebtoken')";
// ok: jgates.js.uses-file-upload
type NoteUpload = "FileInterceptor('file')";

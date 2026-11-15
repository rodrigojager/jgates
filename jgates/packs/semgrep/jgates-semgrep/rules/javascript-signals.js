// Fixture of javascript-signals.yaml: one match and one non-match per rule. Never run.

// ruleid: jgates.js.uses-graphql
import { ApolloServer } from "@apollo/server";
// ruleid: jgates.js.uses-graphql
const { buildSchema } = require("graphql");
// ruleid: jgates.js.uses-graphql
const query = await import("./queries/user.graphql");
// ok: jgates.js.uses-graphql
const NOTE_GQL = "import { buildSchema } from 'graphql'"; // graphql is mentioned in a string only
// ok: jgates.js.uses-graphql
import { graph } from "./graph-tools";

// ruleid: jgates.js.uses-websocket
import WebSocket from "ws";
// ruleid: jgates.js.uses-websocket
const { Server } = require("socket.io");
// ruleid: jgates.js.uses-websocket
const live = new WebSocket("wss://example.test/live");
// ok: jgates.js.uses-websocket
const NOTE_WS = "const ws = require('ws')"; // ws is mentioned in a string only
// ok: jgates.js.uses-websocket
import { sockets } from "./sock-list";

// ruleid: jgates.js.uses-webrtc
import Peer from "simple-peer";
// ruleid: jgates.js.uses-webrtc
const pc = new RTCPeerConnection({ iceServers: [] });
// ruleid: jgates.js.uses-webrtc
const stream = navigator.mediaDevices.getUserMedia({ video: true });
// ok: jgates.js.uses-webrtc
const NOTE_RTC = "import Peer from 'simple-peer'"; // simple-peer is mentioned in a string only
// ok: jgates.js.uses-webrtc
import { peers } from "./peer-list";

// ruleid: jgates.js.uses-oauth-client
import { Issuer } from "openid-client";
// ruleid: jgates.js.uses-oauth-client
const { OAuth2Client } = require("google-auth-library");
// ruleid: jgates.js.uses-oauth-client
const body = { grant_type: "client_credentials", scope: "read" };
// ruleid: jgates.js.uses-oauth-client
const strategy = require("passport-github2");
// ok: jgates.js.uses-oauth-client
const NOTE_OAUTH = "import { Issuer } from 'openid-client'"; // openid-client is mentioned in a string only
// ok: jgates.js.uses-oauth-client
import { authors } from "./authors";

// ruleid: jgates.js.uses-oauth-authorization-server
import Provider from "oidc-provider";
// ruleid: jgates.js.uses-oauth-authorization-server
const OAuth2Server = require("@node-oauth/oauth2-server");
// ruleid: jgates.js.uses-oauth-authorization-server
const oauth2orize = require("oauth2orize");
// ok: jgates.js.uses-oauth-authorization-server
const NOTE_PROVIDER = "import Provider from 'oidc-provider'"; // oidc-provider is mentioned in a string only
// ok: jgates.js.uses-oauth-authorization-server
import { provider } from "./provider";

// ruleid: jgates.js.uses-jwt
import jwt from "jsonwebtoken";
// ruleid: jgates.js.uses-jwt
const { SignJWT } = require("jose");
// ruleid: jgates.js.uses-jwt
const { Strategy } = require("passport-jwt");
// ok: jgates.js.uses-jwt
const NOTE_JWT = "const jwt = require('jsonwebtoken')"; // jsonwebtoken is mentioned in a string only
// ok: jgates.js.uses-jwt
import { josephine } from "./josephine";

// ruleid: jgates.js.uses-saml
import { SAML } from "@node-saml/node-saml";
// ruleid: jgates.js.uses-saml
const samlify = require("samlify");
// ok: jgates.js.uses-saml
const NOTE_SAML = "const samlify = require('samlify')"; // samlify is mentioned in a string only
// ok: jgates.js.uses-saml
import { salmon } from "./salmon";

// ruleid: jgates.js.uses-totp
import * as speakeasy from "speakeasy";
// ruleid: jgates.js.uses-totp
const { authenticator } = require("otplib");
// ruleid: jgates.js.uses-totp
const OTPAuth = require("otpauth");
// ok: jgates.js.uses-totp
const NOTE_TOTP = "const speakeasy = require('speakeasy')"; // speakeasy is mentioned in a string only
// ok: jgates.js.uses-totp
import { motto } from "./motto";

// ruleid: jgates.js.uses-ldap
import ldap from "ldapjs";
// ruleid: jgates.js.uses-ldap
const { Client } = require("ldapts");
// ruleid: jgates.js.uses-ldap
const ActiveDirectory = require("activedirectory2");
// ok: jgates.js.uses-ldap
const NOTE_LDAP = "const ldap = require('ldapjs')"; // ldapjs is mentioned in a string only
// ok: jgates.js.uses-ldap
import { handles } from "./handles";

// ruleid: jgates.js.uses-xml
import { XMLParser } from "fast-xml-parser";
// ruleid: jgates.js.uses-xml
const xml2js = require("xml2js");
// ruleid: jgates.js.uses-xml
const doc = new DOMParser().parseFromString(text, "text/xml");
// ruleid: jgates.js.uses-xml
const $ = cheerio.load(text, { xmlMode: true });
// ok: jgates.js.uses-xml
const NOTE_XML = "const xml2js = require('xml2js')"; // xml2js is mentioned in a string only
// ok: jgates.js.uses-xml
import { exams } from "./exams";

// ruleid: jgates.js.uses-latex
import katex from "katex";
// ruleid: jgates.js.uses-latex
const mathjax = require("mathjax-full");
// ruleid: jgates.js.uses-latex
import rehypeKatex from "rehype-katex";
// ok: jgates.js.uses-latex
const NOTE_TEX = "import katex from 'katex'"; // katex is mentioned in a string only
// ok: jgates.js.uses-latex
import { lattice } from "./lattice";

// ruleid: jgates.js.uses-memcache
const Memcached = require("memcached");
// ruleid: jgates.js.uses-memcache
import memjs from "memjs";
// ok: jgates.js.uses-memcache
const NOTE_MEMCACHE = "const Memcached = require('memcached')"; // memcached is mentioned in a string only
// ok: jgates.js.uses-memcache
import { memories } from "./memories";

// ruleid: jgates.js.uses-mail
import nodemailer from "nodemailer";
// ruleid: jgates.js.uses-mail
const sgMail = require("@sendgrid/mail");
// ruleid: jgates.js.uses-mail
const { SESClient } = require("@aws-sdk/client-ses");
// ok: jgates.js.uses-mail
const NOTE_MAIL = "const nodemailer = require('nodemailer')"; // nodemailer is mentioned in a string only
// ok: jgates.js.uses-mail
import { inventory } from "./inventory";

// ruleid: jgates.js.uses-templates
import ejs from "ejs";
// ruleid: jgates.js.uses-templates
const Handlebars = require("handlebars");
// ruleid: jgates.js.uses-templates
const compiled = _.template("hello <%= name %>");
// ruleid: jgates.js.uses-templates
app.set("view engine", "pug");
// ruleid: jgates.js.uses-templates
res.render("index", { title: "Home" });
// ok: jgates.js.uses-templates
const NOTE_TEMPLATE = "const ejs = require('ejs')"; // ejs is mentioned in a string only
// ok: jgates.js.uses-templates
import { ejection } from "./ejection";

// ruleid: jgates.js.uses-file-upload
import multer from "multer";
// ruleid: jgates.js.uses-file-upload
const formidable = require("formidable");
// ruleid: jgates.js.uses-file-upload
const form = await request.formData();
// ok: jgates.js.uses-file-upload
const NOTE_UPLOAD = "const multer = require('multer')"; // multer is mentioned in a string only
// ok: jgates.js.uses-file-upload
import { loader } from "./loader";

// ruleid: jgates.js.uses-archives
import AdmZip from "adm-zip";
// ruleid: jgates.js.uses-archives
const zlib = require("node:zlib");
// ruleid: jgates.js.uses-archives
const tar = require("tar");
// ok: jgates.js.uses-archives
const NOTE_ZIP = "const AdmZip = require('adm-zip')"; // adm-zip is mentioned in a string only
// ok: jgates.js.uses-archives
import { guitar } from "./guitar";

// ruleid: jgates.js.uses-browser-dom
const el = document.getElementById("app");
// ruleid: jgates.js.uses-browser-dom
const width = window.innerWidth;
// ruleid: jgates.js.uses-browser-dom
import { createRoot } from "react-dom/client";
// ruleid: jgates.js.uses-browser-dom
const saved = localStorage.getItem("theme");
// ok: jgates.js.uses-browser-dom
const NOTE_DOM = "document.getElementById('app')"; // the DOM is mentioned in a string only
// ok: jgates.js.uses-browser-dom
import { documents } from "./documents";

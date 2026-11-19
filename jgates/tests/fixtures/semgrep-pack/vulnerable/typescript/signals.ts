// Uses every technology the JavaScript/TypeScript signal rules cover: one marker each. Never run.
import type { GraphQLSchema } from "graphql";
import { WebSocketServer } from "ws";
import SimplePeer = require("simple-peer");
import { generators } from "openid-client";
import Provider from "oidc-provider";
import { SignJWT } from "jose";
import { ServiceProvider } from "samlify";
import { authenticator } from "otplib";
import { Client } from "ldapts";
import { parseStringPromise } from "xml2js";
import mathjax from "mathjax-full";
import Memcached from "memcached";
import { createTransport } from "nodemailer";
import Handlebars from "handlebars";
import formidable from "formidable";
import { gzipSync } from "node:zlib";
import { createApp } from "vue";

export type Markers = [GraphQLSchema];
export const markers = [WebSocketServer, SimplePeer, generators, Provider, SignJWT, ServiceProvider, authenticator, Client, parseStringPromise, mathjax, Memcached, createTransport, Handlebars, formidable, gzipSync, createApp];

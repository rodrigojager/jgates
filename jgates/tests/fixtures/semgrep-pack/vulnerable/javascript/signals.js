// Uses every technology the JavaScript signal rules cover: one marker each. Never run.
import { ApolloServer } from "@apollo/server";
import WebSocket from "ws";
import Peer from "simple-peer";
import { Issuer } from "openid-client";
import Provider from "oidc-provider";
import jwt from "jsonwebtoken";
import { SAML } from "@node-saml/node-saml";
import * as speakeasy from "speakeasy";
import ldap from "ldapjs";
import { XMLParser } from "fast-xml-parser";
import katex from "katex";
import memjs from "memjs";
import nodemailer from "nodemailer";
import ejs from "ejs";
import multer from "multer";
import AdmZip from "adm-zip";
import { createRoot } from "react-dom/client";

export const markers = [ApolloServer, WebSocket, Peer, Issuer, Provider, jwt, SAML, speakeasy, ldap, XMLParser, katex, memjs, nodemailer, ejs, multer, AdmZip, createRoot];

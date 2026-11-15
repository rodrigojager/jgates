"""Service entry points without any of the technologies. Never run: the twin only has to parse."""
import json
import logging

log = logging.getLogger(__name__)


def start(payload):
    # graphene, jwt, ldap3, smtplib, zipfile and aiortc are mentioned in this comment only
    note = "import graphene; import jwt; from lxml import etree"
    data = json.loads(payload)
    log.info("started %s", note)
    return data

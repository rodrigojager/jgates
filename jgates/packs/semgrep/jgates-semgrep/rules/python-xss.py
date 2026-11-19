import html

import jinja2
from django.http import HttpResponse
from django.utils.safestring import mark_safe
from flask import make_response, request
from markupsafe import Markup, escape


def respond():
    # ruleid: jgates.python.xss-response-write
    HttpResponse("<h1>" + request.GET.get("name") + "</h1>")
    note = request.args["note"]
    # ruleid: jgates.python.xss-response-write
    make_response("<p>" + note + "</p>")
    # ok: jgates.python.xss-response-write
    HttpResponse("<h1>" + html.escape(request.GET.get("name")) + "</h1>")
    # ok: jgates.python.xss-response-write
    make_response("<p>Saved</p>")


def environments():
    # ruleid: jgates.python.xss-template-autoescape-off
    jinja2.Environment(autoescape=False)
    # ruleid: jgates.python.xss-template-autoescape-off
    jinja2.Environment(loader=None, autoescape=False)
    # ok: jgates.python.xss-template-autoescape-off
    jinja2.Environment(autoescape=True)
    # ok: jgates.python.xss-template-autoescape-off
    jinja2.Environment(loader=None)


def mark_data():
    # ruleid: jgates.python.xss-mark-request-data-safe
    Markup(request.form["bio"])
    comment = request.POST.get("comment")
    # ruleid: jgates.python.xss-mark-request-data-safe
    mark_safe(comment)
    # ok: jgates.python.xss-mark-request-data-safe
    Markup(escape(request.form["bio"]))
    # ok: jgates.python.xss-mark-request-data-safe
    mark_safe("<b>fixed</b>")

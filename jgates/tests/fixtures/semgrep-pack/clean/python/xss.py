import html

from django.http import HttpResponse
from flask import request


def greet():
    return HttpResponse("<h1>Hello " + html.escape(request.GET.get("name")) + "</h1>")

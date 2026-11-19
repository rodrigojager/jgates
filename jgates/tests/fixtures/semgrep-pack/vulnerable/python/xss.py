from django.http import HttpResponse
from django.utils.safestring import mark_safe
from flask import request


def greet():
    return HttpResponse("<h1>Hello " + request.GET.get("name") + "</h1>")


def bio():
    return mark_safe(request.POST.get("bio"))

from django.urls import path

from greetings.views import hello

urlpatterns = [
    path("hello/<str:name>/", hello, name="hello"),
]

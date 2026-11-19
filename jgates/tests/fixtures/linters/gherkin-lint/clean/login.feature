Feature: Login

  Scenario: Sign in
    Given a user
    When the user signs in
    Then the home page opens
